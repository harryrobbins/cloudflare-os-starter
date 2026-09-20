// `ChatSession`: what the agent can actually do, and the approval rules around it.
//
// Reads are observations: the data is fetched first (so the description can say what was found) and
// `authorizeObservation()` is awaited before a single row is returned to the caller. Posting is an
// action: it is submitted to the queue and performed only when `applyAction()` arrives.
//
// Posts are NOT simulated -- a submitted post is invisible to later reads until it is approved --
// so every submission sets `awaitDecision`, which tells the harness to suspend the agent's turn
// rather than let it read back a world where its own post "didn't happen".
//
// Only public channels are reachable. The Durable Object already refuses the agent anything else,
// and this file refuses it a second time: every channel id is checked against the public channel
// list before it is read, searched or posted to, so "private conversations are never exposed" does
// not rest on one layer alone.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionDescription, ActionKind, ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";

import {
  MAX_BODY_BYTES,
  type Channel,
  type ChannelId,
  type Message,
  type MessageId,
  type User,
} from "../shared/protocol.js";
import type { ChatBridge } from "./bridge.js";
import { ChatApiError } from "./bridge.js";
import type {
  ChatChannelInfo,
  ChatMessage,
  ChatMessagePage,
  ChatPostOptions,
  ChatReadOptions,
  ChatSearchOptions,
  ChatSearchResult,
  ChatSession,
} from "./types.js";

/** Largest page the agent may ask for. Half the app's own cap: agent context is the scarce resource. */
export const MAX_AGENT_LIMIT = 50;
/** Page size when the caller does not say. */
export const DEFAULT_AGENT_LIMIT = 20;
/** Largest number of channels `listChannels()` and the agent catalog will return. */
export const MAX_AGENT_CHANNELS = 100;

/** The one action kind this gatekeeper submits. Never auto-approvable: a post is visible to people. */
export const CHAT_POST_ACTION: ActionKind = { tag: "chat.post", label: "Post a chat message" };

/** The slice of the approval queue a session needs, so a test can supply two functions. */
export type ChatApprovalQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

/** A post that has been submitted for approval but not yet sent. */
export interface PendingChatPost {
  readonly channelId: ChannelId;
  readonly channelName: string;
  readonly body: string;
  readonly rootId?: MessageId;
  /**
   * The idempotency key the chat API dedupes on, chosen at submit time rather than at apply time.
   * The overseer may call `applyAction()` again after a failure, and a send that actually committed
   * before failing (or a retry of a request whose response was lost) must not post twice.
   */
  readonly clientId: string;
  readonly submittedAt: number;
}

/** A post that was approved and sent, kept so it can be reverted. */
export interface AppliedChatPost {
  readonly messageId: MessageId;
  readonly channelId: ChannelId;
  readonly appliedAt: number;
}

/**
 * Where submitted and applied posts live between RPC calls.
 *
 * The overseer passes back only a number, so everything else has to be durable. `gatekeeper.ts`
 * implements this over the facet's own storage; the tests implement it over a `Map`.
 */
export interface ChatActionStore {
  nextActionId(): number;
  putPending(action: number, post: PendingChatPost): void;
  getPending(action: number): PendingChatPost | undefined;
  deletePending(action: number): void;
  putApplied(action: number, applied: AppliedChatPost): void;
  getApplied(action: number): AppliedChatPost | undefined;
  deleteApplied(action: number): void;
}

/** What a session needs. Injected rather than constructed so the unit tests need no platform. */
export type ChatSessionDependencies = {
  readonly approvalQueue: ChatApprovalQueue;
  readonly bridge: ChatBridge;
  readonly actions: Pick<ChatActionStore, "nextActionId" | "putPending" | "deletePending">;
  readonly now?: () => number;
  readonly newClientId?: () => string;
};

@validateRpc()
export class ChatSessionImpl extends RpcTarget implements ChatSession {
  readonly #approvalQueue: ChatApprovalQueue;
  readonly #bridge: ChatBridge;
  readonly #actions: Pick<ChatActionStore, "nextActionId" | "putPending" | "deletePending">;
  readonly #now: () => number;
  readonly #newClientId: () => string;

  /** Public channels by id, refreshed on a miss so a channel created mid-session is still found. */
  #publicChannels: Map<ChannelId, Channel> | null = null;

  constructor(dependencies: ChatSessionDependencies) {
    super();
    this.#approvalQueue = dependencies.approvalQueue;
    this.#bridge = dependencies.bridge;
    this.#actions = dependencies.actions;
    this.#now = dependencies.now ?? Date.now;
    this.#newClientId = dependencies.newClientId ?? (() => crypto.randomUUID());
  }

  async listChannels(): Promise<ChatChannelInfo[]> {
    // Always fresh: an explicit "what is there?" must not be answered from the guard cache this
    // session filled earlier, or a channel created since would be missing from the answer.
    this.#publicChannels = null;
    const channels = [...(await this.#loadPublicChannels()).values()]
      .filter((channel) => !channel.archived)
      .toSorted((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))
      .slice(0, MAX_AGENT_CHANNELS)
      .map(toChatChannelInfo);

    await this.#approvalQueue.authorizeObservation({
      title: "List team chat channels",
      description:
        `Read the name, topic, purpose and member count of ${countOf(channels.length, "public channel")} ` +
        "in this deployment's team chat. Public channels are readable by everyone who can sign in " +
        "to this deployment.",
    });
    return channels;
  }

  async readMessages(channelId: string, options?: ChatReadOptions): Promise<ChatMessagePage> {
    const channel = await this.#publicChannel(channelId);
    const page = await this.#readPage(channel, options);

    await this.#approvalQueue.authorizeObservation({
      title: `Read messages in #${channel.name ?? channel.id}`,
      description:
        `Read ${countOf(page.messages.length, "message")} from the public channel ` +
        `#${channel.name ?? channel.id}, including who wrote each one and when. ` +
        describeSpan(page.messages),
    });
    return page;
  }

  async readThread(
    channelId: string,
    rootId: string,
    options?: ChatReadOptions,
  ): Promise<ChatMessagePage> {
    const channel = await this.#publicChannel(channelId);
    const page = await this.#readPage(channel, options, rootId);

    await this.#approvalQueue.authorizeObservation({
      title: `Read a thread in #${channel.name ?? channel.id}`,
      description:
        `Read ${countOf(page.messages.length, "message")} from one thread of the public channel ` +
        `#${channel.name ?? channel.id}, including who wrote each one and when. ` +
        describeSpan(page.messages),
    });
    return page;
  }

  async search(query: string, options?: ChatSearchOptions): Promise<ChatSearchResult> {
    const text = query.trim();
    if (text.length === 0) throw new TypeError("A search needs something to search for.");

    const result = await this.#bridge.search(text, {
      limit: boundedLimit(options?.limit),
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    });

    // Defence in depth: the Durable Object filters search by membership, so a hit outside a public
    // channel should be impossible. One stale-cache refresh, then anything still unknown is dropped
    // rather than shown to the agent.
    let visible = await this.#publicChannelIds();
    let hits = result.hits.filter((hit) => visible.has(hit.channelId));
    if (hits.length !== result.hits.length) {
      this.#publicChannels = null;
      visible = await this.#publicChannelIds();
      hits = result.hits.filter((hit) => visible.has(hit.channelId));
    }

    const names = nameIndex(result.users);
    const searchResult: ChatSearchResult = {
      hits: hits.map((hit) => ({
        message: toChatMessage(hit.message, names),
        snippet: hit.snippet,
      })),
      cursor: result.cursor,
    };

    await this.#approvalQueue.authorizeObservation({
      title: "Search team chat",
      description:
        `Search the public channels of this deployment's team chat for "${text}" and read ` +
        `${countOf(searchResult.hits.length, "matching message")}, including who wrote each one ` +
        "and in which channel.",
    });
    return searchResult;
  }

  async postMessage(channelId: string, text: string, options?: ChatPostOptions): Promise<void> {
    const channel = await this.#publicChannel(channelId);
    const body = text.replace(/\s+$/u, "");
    if (body.length === 0) throw new TypeError("A chat message needs a body.");
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new TypeError(`A chat message must be at most ${MAX_BODY_BYTES} bytes (this one is ${bytes}).`);
    }

    const channelName = channel.name ?? channel.id;
    const post: PendingChatPost = {
      channelId: channel.id,
      channelName,
      body,
      ...(options?.rootId === undefined ? {} : { rootId: options.rootId }),
      clientId: this.#newClientId(),
      submittedAt: this.#now(),
    };

    const action = this.#actions.nextActionId();
    this.#actions.putPending(action, post);
    try {
      await this.#approvalQueue.submitAction(action, describeChatPost(post));
    } catch (error) {
      // Nothing was sent, and nothing will call applyAction for an action the queue never took.
      this.#actions.deletePending(action);
      throw error;
    }
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }

  /** One page of a channel, or of one thread within it. Never reaches the caller unauthorized. */
  async #readPage(
    channel: Channel,
    options: ChatReadOptions | undefined,
    rootId?: string,
  ): Promise<ChatMessagePage> {
    const page = await this.#bridge.listMessages(channel.id, {
      limit: boundedLimit(options?.limit),
      ...(options?.before === undefined ? {} : { before: parseCursor(options.before) }),
      ...(rootId === undefined ? {} : { rootId }),
    });
    const names = nameIndex(page.users);
    const oldest = page.messages[0];
    return {
      messages: page.messages.map((message) => toChatMessage(message, names)),
      // The app's own paging cursor is a sequence number; the agent gets it as an opaque string so
      // nothing in the agent's context depends on what it means.
      olderCursor: page.hasMoreBefore && oldest !== undefined ? String(oldest.seq) : null,
    };
  }

  async #publicChannel(channelId: string): Promise<Channel> {
    let channel = (await this.#loadPublicChannels()).get(channelId);
    if (channel === undefined) {
      // Either the id is wrong, or the channel was created after this session started.
      this.#publicChannels = null;
      channel = (await this.#loadPublicChannels()).get(channelId);
    }
    if (channel === undefined) {
      throw new Error(
        `There is no public channel with id ${JSON.stringify(channelId)} in this deployment's ` +
          "team chat. Private channels, group conversations and direct messages are not reachable.",
      );
    }
    return channel;
  }

  async #publicChannelIds(): Promise<Set<ChannelId>> {
    return new Set((await this.#loadPublicChannels()).keys());
  }

  async #loadPublicChannels(): Promise<Map<ChannelId, Channel>> {
    if (this.#publicChannels !== null) return this.#publicChannels;
    const { channels } = await this.#bridge.listChannels();
    const loaded = new Map<ChannelId, Channel>();
    for (const channel of channels) {
      if (channel.kind === "public") loaded.set(channel.id, channel);
    }
    this.#publicChannels = loaded;
    return loaded;
  }
}

/** What the approver is shown before a post is sent. */
export function describeChatPost(post: PendingChatPost): ActionDescription {
  const target = post.rootId === undefined
    ? `channel #${post.channelName}`
    : `a thread in channel #${post.channelName}`;
  return {
    title: `Post a message to #${post.channelName}`,
    description:
      `Post the following message to ${target} of this deployment's team chat, as the built-in ` +
      "**Agent** member. Everyone who can sign in to this deployment will be able to read it.\n\n" +
      `${quote(post.body)}\n`,
    // revertAction deletes the posted message, which leaves the tombstone rule to the chat app.
    implementsRevert: true,
    // Not simulated: reads do not show the post until it is approved, so the agent should wait.
    awaitDecision: true,
    actionKind: CHAT_POST_ACTION,
    // `autoApprovable` is deliberately absent: posting free-form text where colleagues will read it
    // is never safe to apply without a person seeing it first.
  };
}

/**
 * Sends an approved post.
 *
 * Idempotent in both directions: an action already applied is a no-op, and a retry re-uses the
 * stored `clientId`, which the chat API dedupes on.
 */
export async function applyChatPost(
  store: Pick<ChatActionStore, "getPending" | "deletePending" | "getApplied" | "putApplied">,
  bridge: Pick<ChatBridge, "sendMessage">,
  action: number,
  now: () => number = Date.now,
): Promise<void> {
  const pending = store.getPending(action);
  if (pending === undefined) {
    if (store.getApplied(action) !== undefined) return;
    throw new Error(`No queued team chat post has id ${action}.`);
  }

  const response = await bridge.sendMessage(pending.channelId, {
    body: pending.body,
    clientId: pending.clientId,
    ...(pending.rootId === undefined ? {} : { rootId: pending.rootId }),
  });

  store.putApplied(action, {
    messageId: response.message.id,
    channelId: response.message.channelId,
    appliedAt: now(),
  });
  store.deletePending(action);
}

/** Forgets a rejected post. Nothing was simulated, so the session needs no restart. */
export function rejectChatPost(
  store: Pick<ChatActionStore, "deletePending">,
  action: number,
): void {
  store.deletePending(action);
}

/** Deletes a message that was posted, so an approved post can be taken back. */
export async function revertChatPost(
  store: Pick<ChatActionStore, "getApplied" | "deleteApplied">,
  bridge: Pick<ChatBridge, "deleteMessage">,
  action: number,
): Promise<void | { message?: string; canRetry?: boolean }> {
  const applied = store.getApplied(action);
  if (applied === undefined) {
    throw new Error(`No sent team chat post has id ${action}.`);
  }
  try {
    await bridge.deleteMessage(applied.messageId);
  } catch (error) {
    // Already gone counts as reverted; somebody deleted it first.
    if (error instanceof ChatApiError && error.code === "not_found") {
      store.deleteApplied(action);
      return;
    }
    return {
      message:
        `The message could not be deleted from team chat: ${errorText(error)}. Delete it in chat ` +
        "if it needs to go now, or retry.",
      canRetry: true,
    };
  }
  store.deleteApplied(action);
}

/** Maps a channel row to the agent's view of it. */
export function toChatChannelInfo(channel: Channel): ChatChannelInfo {
  return {
    id: channel.id,
    name: channel.name ?? channel.id,
    topic: channel.topic,
    purpose: channel.purpose,
    memberCount: channel.memberCount,
  };
}

/** Maps a message row to the agent's view of it, resolving the author's display name. */
export function toChatMessage(message: Message, names: ReadonlyMap<string, string>): ChatMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    rootId: message.rootId,
    authorId: message.authorId,
    authorName: names.get(message.authorId) ?? message.authorId,
    body: message.body,
    kind: message.kind,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deleted: message.deletedAt !== null,
    replyCount: message.replyCount,
    mentionedUserIds: message.mentions
      .filter((mention) => mention.kind === "user")
      .map((mention) => mention.userId),
    attachmentCount: message.attachments.length,
  };
}

/** Display names by user id, from the directory rows a page carries. */
export function nameIndex(users: readonly User[]): ReadonlyMap<string, string> {
  return new Map(users.map((user) => [user.id, user.name]));
}

/** Clamps a caller-supplied page size into the bounded range the types promise. */
export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_AGENT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_AGENT_LIMIT;
  return Math.min(MAX_AGENT_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Reads back a cursor this session handed out. */
function parseCursor(cursor: string): number {
  const seq = Number(cursor);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError("before must be a cursor from a previous page's olderCursor.");
  }
  return seq;
}

function describeSpan(messages: readonly ChatMessage[]): string {
  const first = messages[0];
  const last = messages.at(-1);
  if (first === undefined || last === undefined) return "The page is empty.";
  return (
    `They were posted between ${new Date(first.createdAt).toISOString()} and ` +
    `${new Date(last.createdAt).toISOString()}.`
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
