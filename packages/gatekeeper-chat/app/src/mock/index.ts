// The in-memory fake.
//
// It implements `ChatApi` and `ChatSocket` against the seed in `seed.ts`, so the entire SPA -- rail,
// unread arithmetic, threads, permalinks, search, uploads, presence, typing, reconnect -- runs without
// the Worker while stream A builds the server. It is reached only through `createTransport()` behind
// the `__CHAT_MOCK__` build constant, so a production bundle never contains it.
//
// It is a fake, not a stub: it enforces the parts of the contract the UI depends on (per-channel
// `seq`, idempotent `clientId`, membership on reads, paging cursors, badge arithmetic), because a
// fake that says yes to everything hides exactly the bugs this app has.

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PROTOCOL_VERSION,
  type Attachment,
  type BadgeSummary,
  type Channel,
  type ChannelId,
  type ChannelListResponse,
  type ChannelResponse,
  type ChatIdentity,
  type ClientEvent,
  type CreateChannelRequest,
  type DeleteMessageResponse,
  type ErrorCode,
  type ListMessagesQuery,
  type ListThreadsQuery,
  type MarkReadRequest,
  type MarkReadResponse,
  type MembershipResponse,
  type MeResponse,
  type Membership,
  type Message,
  type MessageId,
  type MessagePageResponse,
  type MessageResponse,
  type ReactionResponse,
  type SearchHasFilter,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SendMessageRequest,
  type SendMessageResponse,
  type ServerEvent,
  type ThreadListResponse,
  type ThreadResponse,
  type ThreadSummary,
  type UpdateChannelRequest,
  type UpdateMembershipRequest,
  type UpdateMeRequest,
  type User,
  type UserId,
  type UserListResponse,
  type UserResponse,
} from "../contract.js";
import { ApiError, type ChatApi, type ChatSocket, type MockControls, type SocketStatus, type Transport } from "../api/types.js";
import { setFileUrlResolver } from "../lib/files.js";
import { mentionsUser, parseMentions } from "../lib/mentions.js";
import { buildSeed, ME, placeholderImage, type Seed } from "./seed.js";

/** Round-trip delay, so loading states are visible instead of theoretical. */
const LATENCY_MS = 140;

const delay = (ms = LATENCY_MS): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class MockWorkspace {
  readonly seed: Seed = buildSeed();
  /** `clientId` -> committed message, which is what makes a resend idempotent. */
  readonly committed = new Map<string, Message>();
  readonly listeners = new Set<(event: ServerEvent) => void>();
  online: UserId[] = ["u-alice", "u-bob", "u-eve", "u-agent", ME];
  connected = true;
  failWrites = 0;
  failCode: ErrorCode = "internal";
  prefs = { displayName: null as string | null, tz: "Europe/London" as string | null, notify: "all" as const };

  me(): User {
    return this.seed.users.find((user) => user.id === ME)!;
  }

  channel(id: ChannelId): Channel {
    const found = this.seed.channels.find((channel) => channel.id === id);
    if (found === undefined) throw new ApiError("not_found", "No such channel.", 404);
    return found;
  }

  membership(id: ChannelId): Membership {
    const found = this.seed.memberships.find((membership) => membership.channelId === id);
    if (found === undefined) throw new ApiError("forbidden", "You are not a member of that channel.", 403);
    return found;
  }

  setChannel(channel: Channel): void {
    const index = this.seed.channels.findIndex((candidate) => candidate.id === channel.id);
    if (index === -1) this.seed.channels.push(channel);
    else this.seed.channels[index] = channel;
  }

  setMembership(membership: Membership): void {
    const index = this.seed.memberships.findIndex(
      (candidate) => candidate.channelId === membership.channelId,
    );
    if (index === -1) this.seed.memberships.push(membership);
    else this.seed.memberships[index] = membership;
  }

  messagesIn(channelId: ChannelId): Message[] {
    return this.seed.messages
      .filter((message) => message.channelId === channelId)
      .toSorted((a, b) => a.seq - b.seq);
  }

  badges(): BadgeSummary {
    const unread: Record<ChannelId, number> = {};
    const mentions: Record<ChannelId, number> = {};
    for (const membership of this.seed.memberships) {
      const channel = this.channel(membership.channelId);
      const floor =
        membership.manualUnreadSeq === null
          ? membership.lastReadSeq
          : Math.min(membership.lastReadSeq, membership.manualUnreadSeq - 1);
      const missed = this.messagesIn(channel.id).filter(
        (message) => message.seq > floor && message.authorId !== ME && message.rootId === null,
      );
      if (missed.length > 0) unread[channel.id] = missed.length;
      const mentioned = missed.filter((message) => mentionsUser(message.mentions, ME, message.authorId));
      if (mentioned.length > 0) mentions[channel.id] = mentioned.length;
    }
    return { unread, mentions, threads: this.threads().filter((thread) => thread.unreadReplies > 0).length };
  }

  threads(): ThreadSummary[] {
    const roots = new Map<MessageId, Message>();
    for (const message of this.seed.messages) {
      if (message.rootId === null) continue;
      const root = this.seed.messages.find((candidate) => candidate.id === message.rootId);
      if (root !== undefined) roots.set(root.id, root);
    }
    return [...roots.values()].map((root) => {
      const replies = this.seed.messages
        .filter((message) => message.rootId === root.id)
        .toSorted((a, b) => a.seq - b.seq);
      const last = replies[replies.length - 1];
      const unreadReplies = replies.filter(
        (reply) => reply.authorId !== ME && reply.seq > this.membership(root.channelId).lastReadSeq,
      ).length;
      return {
        rootId: root.id,
        channelId: root.channelId,
        root,
        replyCount: replies.length,
        lastReplyAt: last?.createdAt ?? null,
        lastReadReplySeq: this.membership(root.channelId).lastReadSeq,
        unreadReplies,
        following: this.seed.following.has(root.id),
        participantIds: [...new Set(replies.map((reply) => reply.authorId).toReversed())].slice(0, 5),
      };
    });
  }

  emit(event: ServerEvent): void {
    if (!this.connected) return;
    for (const listener of this.listeners) listener(event);
  }

  guardWrite(): void {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new ApiError(this.failCode, "The mock was told to fail this write.", 500);
    }
  }

  nextSeq(channelId: ChannelId): number {
    return this.channel(channelId).lastSeq + 1;
  }

  commit(message: Message): void {
    this.seed.messages.push(message);
    this.setChannel({ ...this.channel(message.channelId), lastSeq: message.seq });
    if (message.clientId !== undefined) this.committed.set(message.clientId, message);
    if (message.rootId !== null) {
      const index = this.seed.messages.findIndex((candidate) => candidate.id === message.rootId);
      if (index !== -1) {
        const root = this.seed.messages[index]!;
        this.seed.messages[index] = {
          ...root,
          replyCount: root.replyCount + 1,
          lastReplyAt: message.createdAt,
        };
      }
      this.seed.following.add(message.rootId);
    }
  }
}

function createMockApi(workspace: MockWorkspace): ChatApi {
  const usersOf = (messages: readonly Message[]): User[] => {
    const ids = new Set(messages.map((message) => message.authorId));
    return workspace.seed.users.filter((user) => ids.has(user.id));
  };

  return {
    async me(): Promise<MeResponse> {
      await delay();
      return {
        user: workspace.me(),
        prefs: workspace.prefs,
        admin: true,
        badges: workspace.badges(),
        limits: { maxBodyBytes: 8192, maxUploadBytes: 10 * 1024 * 1024, maxAttachmentsPerMessage: 10 },
        protocolVersion: PROTOCOL_VERSION,
      };
    },

    async updateMe(request: UpdateMeRequest): Promise<UserResponse> {
      await delay();
      workspace.guardWrite();
      if (request.displayName !== undefined) workspace.prefs = { ...workspace.prefs, displayName: request.displayName };
      const me = workspace.me();
      const renamed: User = { ...me, name: request.displayName?.trim() || me.email?.split("@")[0] || me.name };
      const index = workspace.seed.users.findIndex((user) => user.id === ME);
      workspace.seed.users[index] = renamed;
      return { user: renamed, prefs: workspace.prefs };
    },

    async listChannels(): Promise<ChannelListResponse> {
      await delay();
      const memberChannelIds = new Set(workspace.seed.memberships.map((m) => m.channelId));
      return {
        // The rail shows what you are in; #browse asks for everything, which is the same list here.
        channels: workspace.seed.channels.filter(
          (channel) => memberChannelIds.has(channel.id) || channel.kind === "public",
        ),
        memberships: workspace.seed.memberships,
        users: workspace.seed.users,
        badges: workspace.badges(),
      };
    },

    async createChannel(request: CreateChannelRequest): Promise<ChannelResponse> {
      await delay();
      workspace.guardWrite();
      const id = `c-${Math.random().toString(36).slice(2, 9)}`;
      const memberIds = [...(request.memberIds ?? []), ME];
      const channel: Channel = {
        id,
        kind: request.kind,
        name: request.name ?? null,
        topic: request.topic ?? null,
        purpose: request.purpose ?? null,
        createdBy: ME,
        createdAt: Date.now(),
        archived: false,
        memberCount: request.kind === "dm" || request.kind === "group" ? memberIds.length : 1,
        lastSeq: 0,
        ...(request.kind === "dm" || request.kind === "group" ? { memberIds } : {}),
      };
      workspace.setChannel(channel);
      const membership: Membership = {
        channelId: id,
        userId: ME,
        joinedAt: Date.now(),
        lastReadSeq: 0,
        manualUnreadSeq: null,
        notify: "all",
        muted: false,
        starred: false,
      };
      workspace.setMembership(membership);
      return { channel, membership };
    },

    async updateChannel(channelId: ChannelId, request: UpdateChannelRequest): Promise<ChannelResponse> {
      await delay();
      workspace.guardWrite();
      const channel: Channel = {
        ...workspace.channel(channelId),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.topic === undefined ? {} : { topic: request.topic }),
        ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      };
      workspace.setChannel(channel);
      return { channel, membership: workspace.membership(channelId) };
    },

    async joinChannel(channelId: ChannelId): Promise<ChannelResponse> {
      await delay();
      const channel = workspace.channel(channelId);
      const membership: Membership = {
        channelId,
        userId: ME,
        joinedAt: Date.now(),
        lastReadSeq: channel.lastSeq,
        manualUnreadSeq: null,
        notify: "all",
        muted: false,
        starred: false,
      };
      workspace.setMembership(membership);
      workspace.setChannel({ ...channel, memberCount: channel.memberCount + 1 });
      return { channel: workspace.channel(channelId), membership };
    },

    async leaveChannel(channelId: ChannelId): Promise<ChannelResponse> {
      await delay();
      const channel = workspace.channel(channelId);
      const index = workspace.seed.memberships.findIndex((m) => m.channelId === channelId);
      if (index !== -1) workspace.seed.memberships.splice(index, 1);
      workspace.setChannel({ ...channel, memberCount: Math.max(1, channel.memberCount - 1) });
      return { channel: workspace.channel(channelId), membership: null };
    },

    async archiveChannel(channelId: ChannelId): Promise<ChannelResponse> {
      await delay();
      const channel = { ...workspace.channel(channelId), archived: true };
      workspace.setChannel(channel);
      const systemMessage: Message = {
        id: `m-sys-${Date.now()}`,
        channelId,
        seq: workspace.nextSeq(channelId),
        rootId: null,
        authorId: ME,
        body: `${workspace.me().name} archived #${channel.name ?? "this conversation"}`,
        kind: "system",
        createdAt: Date.now(),
        editedAt: null,
        deletedAt: null,
        replyCount: 0,
        lastReplyAt: null,
        reactions: [],
        attachments: [],
        mentions: [],
      };
      workspace.commit(systemMessage);
      return { channel, membership: workspace.membership(channelId), systemMessage };
    },

    async markRead(channelId: ChannelId, request: MarkReadRequest): Promise<MarkReadResponse> {
      await delay(40);
      const current = workspace.membership(channelId);
      const membership: Membership = {
        ...current,
        ...(request.seq === undefined
          ? {}
          : {
              lastReadSeq: Math.max(current.lastReadSeq, request.seq),
              manualUnreadSeq:
                current.manualUnreadSeq !== null && request.seq >= workspace.channel(channelId).lastSeq
                  ? null
                  : current.manualUnreadSeq,
            }),
        ...(request.manualUnreadSeq === undefined ? {} : { manualUnreadSeq: request.manualUnreadSeq }),
      };
      workspace.setMembership(membership);
      return { membership, badges: workspace.badges() };
    },

    async updateMembership(
      channelId: ChannelId,
      request: UpdateMembershipRequest,
    ): Promise<MembershipResponse> {
      await delay(40);
      const current = workspace.membership(channelId);
      const membership: Membership = {
        ...current,
        ...(request.notify === undefined ? {} : { notify: request.notify }),
        ...(request.muted === undefined ? {} : { muted: request.muted }),
        ...(request.starred === undefined ? {} : { starred: request.starred }),
      };
      workspace.setMembership(membership);
      return { membership, badges: workspace.badges() };
    },

    async listMessages(channelId: ChannelId, query: ListMessagesQuery = {}): Promise<MessagePageResponse> {
      await delay();
      workspace.membership(channelId);
      const limit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
      // A thread page carries its root as well as its replies: the pane has to render the root, and a
      // second round trip for one message it already knows the id of would be silly. (The contract says
      // only that `rootId` "restricts the page to one thread"; the client copes either way -- see
      // ThreadPane's fallback -- but this is the shape it is cheapest to serve.)
      const all =
        query.rootId === undefined
          ? workspace.messagesIn(channelId).filter((message) => message.rootId === null)
          : workspace
              .messagesIn(channelId)
              .filter((message) => message.id === query.rootId || message.rootId === query.rootId);

      let slice: Message[];
      let hasMoreBefore = false;
      let hasMoreAfter = false;

      if (query.around !== undefined) {
        const index = all.findIndex((message) => message.id === query.around);
        if (index === -1) throw new ApiError("not_found", "No such message.", 404);
        const start = Math.max(0, index - Math.floor(limit / 2));
        const end = Math.min(all.length, start + limit);
        slice = all.slice(start, end);
        hasMoreBefore = start > 0;
        hasMoreAfter = end < all.length;
      } else if (query.before !== undefined) {
        const before = query.before;
        const older = all.filter((message) => message.seq < before);
        slice = older.slice(Math.max(0, older.length - limit));
        hasMoreBefore = older.length > slice.length;
        hasMoreAfter = true;
      } else if (query.after !== undefined) {
        const after = query.after;
        const newer = all.filter((message) => message.seq > after);
        slice = newer.slice(0, limit);
        hasMoreBefore = true;
        hasMoreAfter = newer.length > slice.length;
      } else {
        slice = all.slice(Math.max(0, all.length - limit));
        hasMoreBefore = all.length > slice.length;
        hasMoreAfter = false;
      }

      return {
        messages: slice,
        hasMoreBefore,
        hasMoreAfter,
        users: usersOf(slice),
        channelLastSeq: workspace.channel(channelId).lastSeq,
      };
    },

    async sendMessage(channelId: ChannelId, request: SendMessageRequest): Promise<SendMessageResponse> {
      await delay(200);
      const already = workspace.committed.get(request.clientId);
      if (already !== undefined) {
        return { message: already, deduped: true, badges: workspace.badges() };
      }
      workspace.guardWrite();
      workspace.membership(channelId);
      const attachments = (request.attachmentIds ?? [])
        .map((id) => pendingAttachments.get(id))
        .filter((attachment): attachment is Attachment => attachment !== undefined);
      const message: Message = {
        id: `m-${Math.random().toString(36).slice(2, 10)}`,
        channelId,
        seq: workspace.nextSeq(channelId),
        rootId: request.rootId ?? null,
        authorId: ME,
        body: request.body,
        kind: "user",
        createdAt: Date.now(),
        editedAt: null,
        deletedAt: null,
        replyCount: 0,
        lastReplyAt: null,
        reactions: [],
        attachments: attachments.map((attachment) => ({ ...attachment, messageId: null })),
        mentions: parseMentions(request.body),
        clientId: request.clientId,
      };
      workspace.commit(message);
      workspace.emit({ t: "msg", message });
      maybeReply(workspace, message);
      return { message, deduped: false, badges: workspace.badges() };
    },

    async editMessage(messageId: MessageId, body: string): Promise<MessageResponse> {
      await delay();
      workspace.guardWrite();
      const index = workspace.seed.messages.findIndex((message) => message.id === messageId);
      if (index === -1) throw new ApiError("not_found", "No such message.", 404);
      const message: Message = {
        ...workspace.seed.messages[index]!,
        body,
        editedAt: Date.now(),
        mentions: parseMentions(body),
      };
      workspace.seed.messages[index] = message;
      workspace.emit({ t: "edit", message });
      return { message };
    },

    async deleteMessage(messageId: MessageId): Promise<DeleteMessageResponse> {
      await delay();
      workspace.guardWrite();
      const index = workspace.seed.messages.findIndex((message) => message.id === messageId);
      if (index === -1) throw new ApiError("not_found", "No such message.", 404);
      const message = workspace.seed.messages[index]!;
      // The plan's rule: a deleted root with replies leaves a tombstone, everything else vanishes.
      if (message.replyCount > 0) {
        const tombstone: Message = { ...message, body: "", deletedAt: Date.now(), attachments: [] };
        workspace.seed.messages[index] = tombstone;
        workspace.emit({ t: "del", channel: message.channelId, id: messageId, tombstone });
        return { id: messageId, channelId: message.channelId, tombstone };
      }
      workspace.seed.messages.splice(index, 1);
      workspace.emit({ t: "del", channel: message.channelId, id: messageId, tombstone: null });
      return { id: messageId, channelId: message.channelId, tombstone: null };
    },

    addReaction: (messageId, emoji) => react(workspace, messageId, emoji, true),
    removeReaction: (messageId, emoji) => react(workspace, messageId, emoji, false),

    async listThreads(query: ListThreadsQuery = {}): Promise<ThreadListResponse> {
      await delay();
      const threads = workspace
        .threads()
        .filter((thread) => (query.unread === true ? thread.unreadReplies > 0 : true))
        .toSorted((a, b) => (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0));
      return { threads, users: workspace.seed.users, cursor: null };
    },

    async followThread(rootId: MessageId): Promise<ThreadResponse> {
      await delay(40);
      workspace.seed.following.add(rootId);
      const thread = workspace.threads().find((candidate) => candidate.rootId === rootId);
      if (thread === undefined) throw new ApiError("not_found", "No such thread.", 404);
      return { thread };
    },

    async unfollowThread(rootId: MessageId): Promise<ThreadResponse> {
      await delay(40);
      workspace.seed.following.delete(rootId);
      const thread = workspace.threads().find((candidate) => candidate.rootId === rootId);
      if (thread === undefined) throw new ApiError("not_found", "No such thread.", 404);
      return { thread };
    },

    async search(q: string): Promise<SearchResult> {
      await delay(220);
      const parsed = parseSearchQuery(q, workspace);
      const memberChannelIds = new Set(workspace.seed.memberships.map((m) => m.channelId));
      const hits: SearchHit[] = workspace.seed.messages
        .filter((message) => memberChannelIds.has(message.channelId))
        .filter((message) => matches(message, parsed, workspace))
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .slice(0, 40)
        .map((message) => ({
          message,
          channelId: message.channelId,
          snippet: snippetFor(message.body, parsed.text),
          score: -1,
          root:
            message.rootId === null
              ? null
              : (workspace.seed.messages.find((candidate) => candidate.id === message.rootId) ?? null),
        }));
      const needle = parsed.text.toLowerCase();
      return {
        query: parsed,
        hits,
        channels:
          needle.length === 0
            ? []
            : workspace.seed.channels.filter((channel) => channel.name?.includes(needle) === true),
        users:
          needle.length === 0
            ? []
            : workspace.seed.users.filter((user) => user.name.toLowerCase().includes(needle)),
        cursor: null,
      };
    },

    async upload(channelId, file, options): Promise<Attachment> {
      // Fake progress in a few ticks so the progress bar is exercised.
      for (let step = 1; step <= 4; step++) {
        await delay(90);
        options?.onProgress?.({ loaded: (file.size / 4) * step, total: file.size });
      }
      workspace.guardWrite();
      const id = `up-${Math.random().toString(36).slice(2, 10)}`;
      const isImage = file.type.startsWith("image/");
      const attachment: Attachment = {
        id,
        messageId: null,
        channelId,
        uploaderId: ME,
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes: file.size,
        width: isImage ? 800 : null,
        height: isImage ? 500 : null,
        hasThumb: isImage,
        createdAt: Date.now(),
      };
      pendingAttachments.set(id, attachment);
      if (isImage) {
        const url = URL.createObjectURL(file);
        workspace.seed.attachments.set(id, { dataUrl: url, thumbUrl: url });
      }
      return attachment;
    },

    async listUsers(): Promise<UserListResponse> {
      await delay();
      return { users: workspace.seed.users, cursor: null };
    },

    async getUser(userId: UserId): Promise<{ user: User }> {
      await delay(40);
      const user = workspace.seed.users.find((candidate) => candidate.id === userId);
      if (user === undefined) throw new ApiError("not_found", "No such user.", 404);
      return { user };
    },
  };
}

const pendingAttachments = new Map<string, Attachment>();

async function react(
  workspace: MockWorkspace,
  messageId: MessageId,
  emoji: string,
  add: boolean,
): Promise<ReactionResponse> {
  await delay(60);
  workspace.guardWrite();
  const index = workspace.seed.messages.findIndex((message) => message.id === messageId);
  if (index === -1) throw new ApiError("not_found", "No such message.", 404);
  const message = workspace.seed.messages[index]!;
  const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
  let reactions = message.reactions;
  if (add) {
    reactions =
      existing === undefined
        ? [...message.reactions, { emoji, userIds: [ME] }]
        : message.reactions.map((reaction) =>
            reaction.emoji === emoji && !reaction.userIds.includes(ME)
              ? { emoji, userIds: [...reaction.userIds, ME] }
              : reaction,
          );
  } else if (existing !== undefined) {
    const userIds = existing.userIds.filter((id) => id !== ME);
    reactions =
      userIds.length === 0
        ? message.reactions.filter((reaction) => reaction.emoji !== emoji)
        : message.reactions.map((reaction) => (reaction.emoji === emoji ? { emoji, userIds } : reaction));
  }
  workspace.seed.messages[index] = { ...message, reactions };
  workspace.emit({ t: "react", channel: message.channelId, id: messageId, reactions });
  return { messageId, channelId: message.channelId, reactions };
}

/** A lightweight stand-in for the server's qualifier parser, so the chips have something to show. */
function parseSearchQuery(raw: string, workspace: MockWorkspace): SearchQuery {
  const inChannels: ChannelId[] = [];
  const fromUsers: UserId[] = [];
  const toUsers: UserId[] = [];
  const has: SearchHasFilter[] = [];
  let isThread: boolean | undefined;
  let before: number | undefined;
  let after: number | undefined;

  const words: string[] = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = token.split(":");
    const value = rest.join(":");
    if (value.length === 0) {
      words.push(token);
      continue;
    }
    switch (key) {
      case "in": {
        const name = value.replace(/^#/, "");
        const channel = workspace.seed.channels.find((candidate) => candidate.name === name);
        if (channel !== undefined) inChannels.push(channel.id);
        break;
      }
      case "from": {
        const name = value.replace(/^@/, "").toLowerCase();
        const user = workspace.seed.users.find(
          (candidate) => candidate.name.toLowerCase().startsWith(name) || candidate.id === value,
        );
        if (user !== undefined) fromUsers.push(user.id);
        break;
      }
      case "to":
        toUsers.push(value === "me" ? ME : value);
        break;
      case "has":
        if (value === "image" || value === "file" || value === "link") has.push(value);
        break;
      case "is":
        if (value === "thread") isThread = true;
        break;
      case "before":
        before = Date.parse(value) || undefined;
        break;
      case "after":
        after = Date.parse(value) || undefined;
        break;
      case "on": {
        const day = Date.parse(value);
        if (!Number.isNaN(day)) {
          after = day - 1;
          before = day + 86_400_000;
        }
        break;
      }
      default:
        words.push(token);
    }
  }

  return {
    text: words.join(" "),
    ...(inChannels.length > 0 ? { in: inChannels } : {}),
    ...(fromUsers.length > 0 ? { from: fromUsers } : {}),
    ...(toUsers.length > 0 ? { to: toUsers } : {}),
    ...(has.length > 0 ? { has } : {}),
    ...(isThread === undefined ? {} : { isThread }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

function matches(message: Message, query: SearchQuery, workspace: MockWorkspace): boolean {
  if (message.deletedAt !== null) return false;
  if (query.text.length > 0 && !message.body.toLowerCase().includes(query.text.toLowerCase())) return false;
  if (query.in !== undefined && !query.in.includes(message.channelId)) return false;
  if (query.from !== undefined && !query.from.includes(message.authorId)) return false;
  if (query.to !== undefined) {
    const channel = workspace.seed.channels.find((candidate) => candidate.id === message.channelId);
    const direct = channel?.memberIds?.some((id) => query.to!.includes(id)) === true;
    if (!direct && !mentionsUser(message.mentions, query.to[0]!, message.authorId)) return false;
  }
  if (query.has !== undefined) {
    for (const filter of query.has) {
      if (filter === "image" && !message.attachments.some((a) => a.mime.startsWith("image/"))) return false;
      if (filter === "file" && message.attachments.length === 0) return false;
      if (filter === "link" && !/https?:\/\//.test(message.body)) return false;
    }
  }
  if (query.isThread === true && message.rootId === null && message.replyCount === 0) return false;
  if (query.before !== undefined && message.createdAt > query.before) return false;
  if (query.after !== undefined && message.createdAt < query.after) return false;
  return true;
}

/** FTS5-style `snippet()`: the match in context, wrapped in the marks the renderer allow-lists. */
function snippetFor(body: string, text: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (text.length === 0) return flat.slice(0, 180);
  const index = flat.toLowerCase().indexOf(text.toLowerCase());
  if (index === -1) return flat.slice(0, 180);
  const start = Math.max(0, index - 60);
  const end = Math.min(flat.length, index + text.length + 90);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return (
    prefix +
    flat.slice(start, index) +
    "<mark>" +
    flat.slice(index, index + text.length) +
    "</mark>" +
    flat.slice(index + text.length, end) +
    suffix
  );
}

/** Makes the fake feel alive: somebody types, then answers, a few seconds after you post. */
function maybeReply(workspace: MockWorkspace, sent: Message): void {
  const responders = ["u-alice", "u-bob", "u-eve"] as const;
  const responder = responders[Math.floor(Math.random() * responders.length)]!;
  const channel = workspace.seed.channels.find((candidate) => candidate.id === sent.channelId);
  if (channel === undefined) return;
  setTimeout(() => workspace.emit({ t: "typing", channel: sent.channelId, user: responder }), 900);
  setTimeout(() => {
    const replies = [
      "Makes sense to me.",
      "I'll pick that up after standup.",
      "Nice — that was the last thing on my list.",
      "Can you put that in the thread so it does not get lost?",
    ];
    const message: Message = {
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      channelId: sent.channelId,
      seq: workspace.nextSeq(sent.channelId),
      rootId: sent.rootId,
      authorId: responder,
      body: replies[Math.floor(Math.random() * replies.length)]!,
      kind: "user",
      createdAt: Date.now(),
      editedAt: null,
      deletedAt: null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: [],
      attachments: [],
      mentions: [],
    };
    workspace.commit(message);
    workspace.emit({ t: "msg", message });
    const badges = workspace.badges();
    workspace.emit({ t: "badge", unread: badges.unread, mentions: badges.mentions, threads: badges.threads });
  }, 2600);
}

function createMockSocket(workspace: MockWorkspace): ChatSocket {
  let status: SocketStatus = "idle";
  const statusListeners = new Set<(status: SocketStatus) => void>();
  let presenceTimer: ReturnType<typeof setInterval> | null = null;

  const setStatus = (next: SocketStatus): void => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  return {
    open(): void {
      setStatus("connecting");
      setTimeout(() => {
        if (!workspace.connected) {
          setStatus("reconnecting");
          return;
        }
        setStatus("open");
        const lastSeq: Record<ChannelId, number> = {};
        for (const channel of workspace.seed.channels) lastSeq[channel.id] = channel.lastSeq;
        workspace.emit({
          t: "hello",
          user: workspace.me(),
          sessionId: "mock-session",
          serverTime: Date.now(),
          protocolVersion: PROTOCOL_VERSION,
          lastSeq,
        });
        workspace.emit({ t: "presence", online: workspace.online });
        presenceTimer = setInterval(
          () => workspace.emit({ t: "presence", online: workspace.online }),
          15_000,
        );
      }, 220);
    },
    close(): void {
      if (presenceTimer !== null) clearInterval(presenceTimer);
      presenceTimer = null;
      setStatus("closed");
    },
    send(event: ClientEvent): void {
      // `read` is mirrored back the way the real server would, so multi-tab behaviour is visible.
      if (event.t === "read") {
        workspace.emit({ t: "read", channel: event.channel, seq: event.seq });
      }
    },
    status: () => status,
    retryInSeconds: () => (status === "reconnecting" ? 3 : null),
    onEvent(listener): () => void {
      workspace.listeners.add(listener);
      return () => workspace.listeners.delete(listener);
    },
    onStatus(listener): () => void {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
  };
}

export function createMockTransport(): Transport {
  const workspace = new MockWorkspace();

  // The fake has no `/files/` route, so attachment URLs resolve to the inline placeholders instead.
  setFileUrlResolver((id, thumb) => {
    const entry = workspace.seed.attachments.get(id);
    if (entry === undefined) return placeholderImage(id, 400, 260, "file");
    return thumb ? entry.thumbUrl : entry.dataUrl;
  });

  const controls: MockControls = {
    injectMessage(channelId, authorId, body): void {
      const message: Message = {
        id: `m-${Math.random().toString(36).slice(2, 10)}`,
        channelId,
        seq: workspace.nextSeq(channelId),
        rootId: null,
        authorId,
        body,
        kind: "user",
        createdAt: Date.now(),
        editedAt: null,
        deletedAt: null,
        replyCount: 0,
        lastReplyAt: null,
        reactions: [],
        attachments: [],
        mentions: parseMentions(body),
      };
      workspace.commit(message);
      workspace.emit({ t: "msg", message });
    },
    setOnline(userIds): void {
      workspace.online = [...userIds];
      workspace.emit({ t: "presence", online: workspace.online });
    },
    startTyping(channelId, userId): void {
      workspace.emit({ t: "typing", channel: channelId, user: userId });
    },
    setConnected(connected): void {
      workspace.connected = connected;
    },
    failNextWrites(count, code): void {
      workspace.failWrites = count;
      if (code !== undefined) workspace.failCode = code;
    },
  };

  return { api: createMockApi(workspace), socket: createMockSocket(workspace), mock: controls };
}

/** Exposed so a dev script can log in as somebody else in the fake. */
export const MOCK_IDENTITY: ChatIdentity = { id: ME, email: "harry@example.test", name: "Harry Robbins" };
