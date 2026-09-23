// The one store.
//
// A plain class with an immutable snapshot and `useSyncExternalStore`, rather than a reducer library:
// the interesting logic is the unread arithmetic, the catch-up merge and the optimistic send, and all
// three live in `unread.ts` and `merge.ts` as pure functions this class only sequences. That is also
// why the store takes a `Transport` rather than reaching for `fetch`: the mock swaps it wholesale.

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  permalink,
  utf8Bytes,
  type Attachment,
  type Channel,
  type ChannelId,
  type ChannelKind,
  type Membership,
  type Message,
  type MessageId,
  type NotifyLevel,
  type ReadCursor,
  type ServerEvent,
  type ThreadSummary,
  type UpdateMembershipRequest,
  type User,
  type UserId,
} from "../contract.js";
import { ApiError, type ChatApi, type ChatSocket, type SocketStatus, type Transport } from "../api/types.js";
import { channelLabel } from "../lib/labels.js";
import { recordEmojiUse } from "../lib/reactions.js";
import { toPlainText } from "../lib/markdown.js";
import { mentionsToText, parseMentions, resolveMentions } from "../lib/mentions.js";
import { conversationKey, loadDrafts, readSetting, saveDrafts, writeSetting } from "./drafts.js";
import {
  localLastSeq,
  markSendFailed,
  mergeMessages,
  optimisticMessage,
  planCatchUp,
  applyAgentRequest,
  applyDelete,
  applyReactions,
  reconcileSend,
  removeLocal,
  toggleReaction,
  type LocalMessage,
} from "./merge.js";
import {
  applyIncoming,
  applyRead,
  badgeTotals,
  clearChannelBadges,
  documentTitle,
  firstUnreadSeq,
  shouldNotify,
} from "./unread.js";
import {
  EMPTY_CONVERSATION,
  INITIAL_STATE,
  type ChatState,
  type ConversationState,
  type LocalReadCursor,
  type QueuedUpload,
  type ThemeMode,
  type Toast,
} from "./state.js";

const THEME_KEY = "chat.theme";
const NOTIFY_OPT_IN_KEY = "chat.notifications";
/** Floor between two `listChannels` triggered by an unrecognised channel id. */
const UNKNOWN_CHANNEL_REFRESH_MS = 5_000;
/**
 * Unknown people are looked up in batches: ids noticed within this window go in one request, so a burst
 * of events naming the same newcomer (their message, their typing, a reaction) costs one round trip.
 */
const USER_RESOLVE_DELAY_MS = 30;
/** An id the directory did not return is not asked for again until this has passed. */
const MISSING_USER_RETRY_MS = 5 * 60_000;
/** After a failed lookup (offline, a 5xx), the ids in it wait this long before another try. */
const FAILED_USER_RETRY_MS = 30_000;
const TYPING_TTL_MS = 6000;
/** How long a toast lives. Errors are sticky; everything else clears itself. */
const TOAST_TIMEOUT_MS = 6000;

export interface StoreDeps {
  readonly transport: Transport;
  /** Injected so tests can drive it; the app passes the router's navigate. */
  readonly navigate?: (href: string) => void;
}

export class ChatStore {
  #state: ChatState = INITIAL_STATE;
  readonly #listeners = new Set<() => void>();
  readonly #api: ChatApi;
  readonly #socket: ChatSocket;
  #navigate: (href: string) => void = () => undefined;
  /** Message ids already notified, so a socket echo and a catch-up page cannot double-notify. */
  readonly #notified = new Set<MessageId>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #draftFlush: ReturnType<typeof setTimeout> | null = null;
  #catchUpRunning = false;
  #disposed = false;

  constructor(deps: StoreDeps) {
    this.#api = deps.transport.api;
    this.#socket = deps.transport.socket;
    if (deps.navigate !== undefined) this.#navigate = deps.navigate;
    this.mock = deps.transport.mock;
  }

  /** Present only under `VITE_CHAT_MOCK=1`; the dev tools panel uses it. */
  readonly mock: Transport["mock"];

  // --- snapshot plumbing ----------------------------------------------------

  get state(): ChatState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ChatState => this.#state;

  setNavigate(navigate: (href: string) => void): void {
    this.#navigate = navigate;
  }

  #patch(patch: Partial<ChatState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #later(run: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#disposed) run();
    }, delay);
    this.#timers.add(timer);
  }

  // --- lifecycle ------------------------------------------------------------

  async start(options: { embedded: boolean; compact?: boolean }): Promise<void> {
    const storedTheme = readSetting(THEME_KEY);
    const override: ThemeMode | null =
      storedTheme === "light" || storedTheme === "dark" ? storedTheme : null;
    this.#patch({
      embedded: options.embedded,
      compact: options.compact ?? false,
      drafts: loadDrafts(),
      themeOverride: override,
      theme: override ?? systemTheme(),
      notificationsOptIn: readSetting(NOTIFY_OPT_IN_KEY) === "1",
      notificationPermission: notificationPermission(),
    });
    this.applyTheme();

    this.#socket.onStatus((status) => this.#onSocketStatus(status));
    this.#socket.onEvent((event) => this.#onSocketEvent(event));

    try {
      const [me, channels] = await Promise.all([this.#api.me(), this.#api.listChannels()]);
      this.#patch({
        phase: "ready",
        me: me.user,
        prefs: me.prefs,
        admin: me.admin,
        agentReplies: me.agent.replies,
        limits: me.limits,
        badges: channels.badges,
        channels: byId(channels.channels),
        memberships: byChannel(channels.memberships),
        users: { ...byId(channels.users), [me.user.id]: me.user },
      });
      this.#updateTitle();
      this.#socket.open();
      this.#subscribeAll();
      void this.loadThreads();
    } catch (cause) {
      this.#patch({ phase: "error", fatalError: describe(cause) });
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#draftFlush !== null) clearTimeout(this.#draftFlush);
    this.#socket.close();
  }

  // --- socket ---------------------------------------------------------------

  #onSocketStatus(status: SocketStatus): void {
    this.#patch({ socketStatus: status, retryInSeconds: this.#socket.retryInSeconds() });
    if (status === "reconnecting") {
      // One tick per second so the banner can count down without its own timer.
      this.#later(() => {
        if (this.#socket.status() === "reconnecting") this.#onSocketStatus("reconnecting");
      }, 1000);
    }
  }

  #onSocketEvent(event: ServerEvent): void {
    switch (event.t) {
      case "hello": {
        this.#patch({ users: { ...this.#state.users, [event.user.id]: event.user }, me: event.user });
        this.#retryMissingUsers();
        void this.#catchUp(event.lastSeq);
        this.#subscribeAll();
        return;
      }
      case "msg":
        // The server names the author in the event; merge them before the message lands, so neither
        // the row nor a notification ever renders them as "Unknown".
        if (event.author !== undefined) this.#mergeUsers([event.author]);
        this.#receive(event.message);
        return;
      case "edit":
        this.#noticeUsers(userIdsOf([event.message]));
        this.#applyToConversations(event.message.channelId, event.message.rootId, (conversation) => ({
          ...conversation,
          messages: mergeMessages(conversation.messages, [event.message]),
        }));
        return;
      case "del":
        this.#forEachConversationOf(event.channel, (key, conversation) => {
          this.#setConversation(key, {
            ...conversation,
            messages: applyDelete(conversation.messages, event.id, event.tombstone),
          });
        });
        return;
      case "agent":
        this.#noticeUsers([event.request.requesterId]);
        // Every conversation of the channel, not just the message's own: a top-level question is
        // also the root of the thread its answer goes into, and that pane holds a copy of it.
        this.#forEachConversationOf(event.channel, (key, conversation) => {
          this.#setConversation(key, {
            ...conversation,
            messages: applyAgentRequest(conversation.messages, event.id, event.request),
          });
        });
        return;
      case "react":
        this.#noticeUsers(event.reactions.flatMap((reaction) => reaction.userIds));
        this.#forEachConversationOf(event.channel, (key, conversation) => {
          this.#setConversation(key, {
            ...conversation,
            messages: applyReactions(conversation.messages, event.id, event.reactions),
          });
        });
        return;
      case "read": {
        // Two cases in one frame, told apart by `userId`: my own read from another tab (mirror it so
        // this tab's rail agrees) or somebody else's, in a dm or group, which only moves "seen by".
        // The server always sets `userId`; it is optional in the type so a mock need not.
        if (event.userId !== undefined && event.userId !== this.#state.me?.id) {
          this.#noticeUsers([event.userId]);
          this.#applyReadCursor(event.channel, event.userId, event.seq);
          return;
        }
        const membership = this.#state.memberships[event.channel];
        if (membership === undefined) return;
        const channel = this.#state.channels[event.channel];
        this.#patch({
          memberships: {
            ...this.#state.memberships,
            [event.channel]: applyRead(membership, event.seq, channel?.lastSeq ?? event.seq),
          },
        });
        return;
      }
      case "presence":
        this.#patch({ online: event.online });
        this.#noticeUsers(event.online);
        return;
      case "typing": {
        if (event.user === this.#state.me?.id) return;
        this.#noticeUsers([event.user]);
        const forChannel = { ...this.#state.typing[event.channel] };
        forChannel[event.user] = Date.now() + TYPING_TTL_MS;
        this.#patch({ typing: { ...this.#state.typing, [event.channel]: forChannel } });
        this.#later(() => this.#expireTyping(), TYPING_TTL_MS + 250);
        return;
      }
      case "badge": {
        this.#patch({
          badges: { unread: event.unread, mentions: event.mentions, threads: event.threads },
        });
        this.#updateTitle();
        // A badge naming a conversation the rail has never heard of is how a new DM, a new group or a
        // private channel somebody added you to arrives: the server pushes fresh badges to every
        // member when a channel is created and when a message lands, but there is no "channel
        // created" event, and a socket that has subscribed to a channel list cannot receive `msg` for
        // a channel that was not on it.
        this.#refreshIfUnknown([...Object.keys(event.unread), ...Object.keys(event.mentions)]);
        return;
      }
      case "error":
        // A frame the server refused. Surfaced quietly: it is a client bug, not the user's problem.
        this.#toast({ tone: "error", title: "The chat server rejected a request", body: event.message });
        return;
    }
  }

  /** One other member's cursor, never backwards: two tabs of theirs can report out of order. */
  #applyReadCursor(channelId: ChannelId, userId: UserId, seq: number): void {
    const current = this.#state.readCursors[channelId] ?? [];
    const existing = current.find((cursor) => cursor.userId === userId);
    if (existing !== undefined && existing.lastReadSeq >= seq) return;
    // The event is the only place a *time* for somebody else's read is ever available, so it is
    // captured here; a cursor that arrived with the page keeps none.
    const moved: LocalReadCursor = { userId, lastReadSeq: seq, seenAt: Date.now() };
    const next: LocalReadCursor[] =
      existing === undefined
        ? [...current, moved]
        : current.map((cursor) => (cursor.userId === userId ? moved : cursor));
    this.#patch({ readCursors: { ...this.#state.readCursors, [channelId]: next } });
  }

  /** One `listChannels` when a channel id turns up that the rail does not have. Guarded against loops. */
  #refreshIfUnknown(channelIds: readonly ChannelId[]): void {
    const unknown = channelIds.filter((id) => this.#state.channels[id] === undefined);
    if (unknown.length === 0) return;
    const now = Date.now();
    // A channel that is genuinely invisible would otherwise be refetched on every badge frame.
    if (now - this.#lastUnknownRefresh < UNKNOWN_CHANNEL_REFRESH_MS) return;
    this.#lastUnknownRefresh = now;
    void this.refreshChannels();
  }

  #lastUnknownRefresh = 0;

  #expireTyping(): void {
    const now = Date.now();
    let changed = false;
    const next: Record<ChannelId, Record<UserId, number>> = {};
    for (const [channelId, users] of Object.entries(this.#state.typing)) {
      const live: Record<UserId, number> = {};
      for (const [userId, expires] of Object.entries(users)) {
        if (expires > now) live[userId] = expires;
        else changed = true;
      }
      if (Object.keys(live).length > 0) next[channelId] = live;
    }
    if (changed) this.#patch({ typing: next });
  }

  #subscribeAll(): void {
    const channels = Object.keys(this.#state.memberships);
    if (channels.length > 0) this.#socket.send({ t: "sub", channels });
  }

  /**
   * The `hello`-driven catch-up.
   *
   * The socket replays nothing; `hello` reports each channel's high-water mark and anything above what
   * this client holds is fetched over HTTP with `after=` paging. Only conversations the client has
   * actually loaded are caught up -- an unopened channel's history arrives when it is opened, and its
   * badge comes from the server's summary.
   */
  async #catchUp(serverLastSeq: Readonly<Record<ChannelId, number>>): Promise<void> {
    if (this.#catchUpRunning) return;
    this.#catchUpRunning = true;
    try {
      // The rail's counters may have moved while the socket was down.
      void this.refreshChannels();
      for (const [channelId, lastSeq] of Object.entries(serverLastSeq)) {
        const conversation = this.#state.conversations[channelId];
        const plan = planCatchUp({
          serverLastSeq: lastSeq,
          localLastSeq: conversation === undefined ? 0 : localLastSeq(conversation.messages),
          loaded: conversation?.loaded === true,
        });
        if (plan.after === null) continue;
        let after: number | null = plan.after;
        // Bounded paging: a long absence must not turn into an unbounded fetch loop.
        for (let page = 0; page < 10 && after !== null; page++) {
          const response = await this.#api.listMessages(channelId, {
            after,
            limit: MAX_PAGE_LIMIT,
          });
          for (const message of response.messages) this.#receive(message, { catchUp: true });
          after = response.hasMoreAfter && response.messages.length > 0
            ? response.messages[response.messages.length - 1]!.seq
            : null;
        }
      }
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not catch up on missed messages", body: describe(cause) });
    } finally {
      this.#catchUpRunning = false;
    }
  }

  // --- reading messages -----------------------------------------------------

  /** Applies one arriving message everywhere it belongs, then decides whether to notify. */
  #receive(message: Message, options: { catchUp?: boolean } = {}): void {
    this.#noticeUsers(userIdsOf([message]));
    const channel = this.#state.channels[message.channelId];
    if (channel !== undefined && message.seq > channel.lastSeq) {
      this.#patch({
        channels: {
          ...this.#state.channels,
          [message.channelId]: { ...channel, lastSeq: message.seq },
        },
      });
    }
    this.#applyToConversations(message.channelId, message.rootId, (conversation) => ({
      ...conversation,
      messages: mergeMessages(conversation.messages, [message]),
    }));

    // A reply bumps its root's summary line without refetching the thread.
    if (message.rootId !== null) this.#bumpRoot(message.channelId, message.rootId, message);

    const me = this.#state.me;
    if (me === null) return;
    const membership = this.#state.memberships[message.channelId];
    if (message.authorId !== me.id) {
      this.#patch({ badges: applyIncoming(this.#state.badges, message, me.id, membership) });
      this.#updateTitle();
    }
    this.#maybeMarkRead(message.channelId);
    if (options.catchUp !== true) this.#maybeNotify(message);
  }

  /**
   * Keeps a root's thread summary line current when a reply arrives.
   *
   * Optimistic and deliberately approximate: the count is incremented locally so the line updates the
   * instant the reply lands, and the server's own `replyCount` overwrites it on the next page or edit
   * event. Guarded so replaying the same reply twice cannot inflate it.
   */
  #bumpRoot(channelId: ChannelId, rootId: MessageId, reply: Message): void {
    this.#forEachConversationOf(channelId, (key, conversation) => {
      const root = conversation.messages.find((message) => message.id === rootId);
      if (root === undefined) return;
      if (root.lastReplyAt !== null && reply.createdAt <= root.lastReplyAt) return;
      this.#setConversation(key, {
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.id === rootId
            ? { ...message, replyCount: message.replyCount + 1, lastReplyAt: reply.createdAt }
            : message,
        ),
      });
    });
  }

  /** Opens a conversation: a channel, a thread, or a permalink's surroundings. */
  async openConversation(
    channelId: ChannelId,
    options: { rootId?: MessageId | null; around?: MessageId } = {},
  ): Promise<void> {
    const rootId = options.rootId ?? null;
    const key = conversationKey(channelId, rootId);
    const existing = this.#state.conversations[key] ?? EMPTY_CONVERSATION;

    // Already loaded and nothing to centre on: keep the scroll position and the pending rows.
    if (existing.loaded && options.around === undefined) {
      this.#maybeMarkRead(channelId);
      return;
    }
    this.#setConversation(key, { ...existing, loading: true, error: null });
    try {
      const page = await this.#api.listMessages(channelId, {
        ...(options.around === undefined ? {} : { around: options.around }),
        ...(rootId === null ? {} : { rootId }),
        limit: DEFAULT_PAGE_LIMIT,
      });
      this.#mergeUsers(page.users);
      // A page names its authors; a mention, a reactor or an asker on it may still be a stranger.
      this.#noticeUsers(userIdsOf(page.messages));
      this.#mergeReadCursors(channelId, page.readCursors);
      const channel = this.#state.channels[channelId];
      if (channel !== undefined && page.channelLastSeq > channel.lastSeq) {
        this.#patch({
          channels: {
            ...this.#state.channels,
            [channelId]: { ...channel, lastSeq: page.channelLastSeq },
          },
        });
      }
      this.#setConversation(key, {
        ...(this.#state.conversations[key] ?? EMPTY_CONVERSATION),
        messages: mergeMessages(
          (this.#state.conversations[key] ?? EMPTY_CONVERSATION).messages,
          page.messages,
        ),
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        loading: false,
        loaded: true,
        error: null,
        focusMessageId: options.around ?? null,
      });
      this.#maybeMarkRead(channelId);
    } catch (cause) {
      this.#setConversation(key, {
        ...(this.#state.conversations[key] ?? EMPTY_CONVERSATION),
        loading: false,
        error: describe(cause),
      });
    }
  }

  /** Upwards infinite scroll. */
  async loadOlder(channelId: ChannelId, rootId: MessageId | null = null): Promise<void> {
    const key = conversationKey(channelId, rootId);
    const conversation = this.#state.conversations[key];
    if (conversation === undefined || conversation.loadingOlder || !conversation.hasMoreBefore) return;
    const oldest = conversation.messages.find((message) => message.local === undefined);
    if (oldest === undefined) return;
    this.#setConversation(key, { ...conversation, loadingOlder: true });
    try {
      const page = await this.#api.listMessages(channelId, {
        before: oldest.seq,
        ...(rootId === null ? {} : { rootId }),
        limit: DEFAULT_PAGE_LIMIT,
      });
      this.#mergeUsers(page.users);
      this.#noticeUsers(userIdsOf(page.messages));
      const current = this.#state.conversations[key] ?? EMPTY_CONVERSATION;
      this.#setConversation(key, {
        ...current,
        messages: mergeMessages(current.messages, page.messages),
        hasMoreBefore: page.hasMoreBefore,
        loadingOlder: false,
      });
    } catch (cause) {
      this.#setConversation(key, {
        ...(this.#state.conversations[key] ?? EMPTY_CONVERSATION),
        loadingOlder: false,
      });
      this.#toast({ tone: "error", title: "Could not load older messages", body: describe(cause) });
    }
  }

  clearFocusMessage(channelId: ChannelId, rootId: MessageId | null = null): void {
    const key = conversationKey(channelId, rootId);
    const conversation = this.#state.conversations[key];
    if (conversation === undefined || conversation.focusMessageId === null) return;
    this.#setConversation(key, { ...conversation, focusMessageId: null });
  }

  // --- sending --------------------------------------------------------------

  /**
   * Optimistic send.
   *
   * The `clientId` is generated here and is what makes a retry idempotent: the server answers a repeat
   * with `deduped: true` and the same message, which reconciles exactly as a first success does.
   */
  async send(
    channelId: ChannelId,
    options: { rootId?: MessageId | null; alsoSendToChannel?: boolean } = {},
  ): Promise<void> {
    const rootId = options.rootId ?? null;
    const key = conversationKey(channelId, rootId);
    // The composer holds display text; the wire carries id tokens.
    const body = resolveMentions(
      (this.#state.drafts[key]?.body ?? "").trim(),
      Object.values(this.#state.users),
      Object.values(this.#state.channels),
    );
    const queued = this.#state.uploads[key] ?? [];
    const attachments = queued
      .map((upload) => upload.attachment)
      .filter((attachment): attachment is Attachment => attachment !== null);

    if (body.length === 0 && attachments.length === 0) return;
    if (utf8Bytes(body) > this.#state.limits.maxBodyBytes) {
      this.#toast({
        tone: "error",
        title: "That message is too long",
        body: `Messages are capped at ${Math.floor(this.#state.limits.maxBodyBytes / 1024)} KiB.`,
      });
      return;
    }
    if (queued.some((upload) => upload.state === "uploading")) {
      this.#toast({ tone: "info", title: "Wait for the upload to finish" });
      return;
    }
    const me = this.#state.me;
    if (me === null) return;

    this.setDraft(key, "");
    this.#patch({ uploads: { ...this.#state.uploads, [key]: [] } });

    const clientId = newId();
    await this.#commit(channelId, key, {
      clientId,
      body,
      rootId,
      attachmentIds: attachments.map((attachment) => attachment.id),
      attachments,
      authorId: me.id,
    });

    // "Also send to #channel": a second top-level message quoting the reply, which is what Slack does
    // and what the contract allows without a dedicated field.
    if (options.alsoSendToChannel === true && rootId !== null) {
      await this.#commit(channelId, conversationKey(channelId), {
        clientId: newId(),
        body,
        rootId: null,
        attachmentIds: [],
        attachments: [],
        authorId: me.id,
      });
    }
  }

  async #commit(
    channelId: ChannelId,
    key: string,
    params: {
      clientId: string;
      body: string;
      rootId: MessageId | null;
      attachmentIds: readonly string[];
      attachments: readonly Attachment[];
      authorId: UserId;
    },
  ): Promise<void> {
    const optimistic = optimisticMessage({
      clientId: params.clientId,
      channelId,
      authorId: params.authorId,
      body: params.body,
      rootId: params.rootId,
      attachments: params.attachments,
      mentions: parseMentions(params.body),
    });
    this.#setConversation(key, {
      ...(this.#state.conversations[key] ?? EMPTY_CONVERSATION),
      messages: mergeMessages(
        (this.#state.conversations[key] ?? EMPTY_CONVERSATION).messages,
        [],
      ).concat(optimistic),
      atBottom: true,
    });

    try {
      const response = await this.#api.sendMessage(channelId, {
        body: params.body,
        clientId: params.clientId,
        ...(params.rootId === null ? {} : { rootId: params.rootId }),
        ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
      });
      const current = this.#state.conversations[key] ?? EMPTY_CONVERSATION;
      this.#setConversation(key, {
        ...current,
        messages: reconcileSend(current.messages, params.clientId, response.message),
      });
      this.#patch({ badges: response.badges });
      this.#updateTitle();
      // The root's own copy of the reply count comes from the server, not our local bump.
      if (params.rootId !== null) void this.loadThreads();
    } catch (cause) {
      const current = this.#state.conversations[key] ?? EMPTY_CONVERSATION;
      this.#setConversation(key, {
        ...current,
        messages: markSendFailed(current.messages, params.clientId, describe(cause)),
      });
      this.#toast({
        tone: "error",
        title: "Message not sent",
        body: describe(cause),
        action: { label: "Retry", run: () => void this.retrySend(channelId, key, params.clientId) },
      });
    }
  }

  /** Re-posts a failed message with its original `clientId`, so a send that actually landed dedupes. */
  async retrySend(channelId: ChannelId, key: string, clientId: string): Promise<void> {
    const conversation = this.#state.conversations[key];
    const failed = conversation?.messages.find(
      (message) => message.clientId === clientId && message.local !== undefined,
    );
    if (conversation === undefined || failed === undefined) return;
    this.#setConversation(key, {
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.clientId === clientId ? { ...message, local: { state: "pending" as const } } : message,
      ),
    });
    await this.#commit(channelId, key, {
      clientId,
      body: failed.body,
      rootId: failed.rootId,
      attachmentIds: failed.attachments.map((attachment) => attachment.id),
      attachments: failed.attachments,
      authorId: failed.authorId,
    });
  }

  /** Throws away a failed send, putting its text back in the composer so nothing is lost. */
  discardSend(key: string, clientId: string): void {
    const conversation = this.#state.conversations[key];
    const failed = conversation?.messages.find((message) => message.clientId === clientId);
    if (conversation === undefined || failed === undefined) return;
    this.#setConversation(key, {
      ...conversation,
      messages: removeLocal(conversation.messages, clientId),
    });
    if ((this.#state.drafts[key]?.body ?? "").length === 0) this.setDraft(key, failed.body);
  }

  /** `body` arrives as display text from the inline editor, the same as a new message does. */
  async editMessage(messageId: MessageId, body: string): Promise<void> {
    try {
      const response = await this.#api.editMessage(
        messageId,
        resolveMentions(body, Object.values(this.#state.users), Object.values(this.#state.channels)),
      );
      this.#applyToConversations(
        response.message.channelId,
        response.message.rootId,
        (conversation) => ({
          ...conversation,
          messages: mergeMessages(conversation.messages, [response.message]),
        }),
      );
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not save the edit", body: describe(cause) });
    }
  }

  async deleteMessage(messageId: MessageId): Promise<void> {
    try {
      const response = await this.#api.deleteMessage(messageId);
      this.#forEachConversationOf(response.channelId, (key, conversation) => {
        this.#setConversation(key, {
          ...conversation,
          messages: applyDelete(conversation.messages, response.id, response.tombstone),
        });
      });
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not delete the message", body: describe(cause) });
    }
  }

  /** Asks the Agent again after a failed question. The server checks that the caller asked it. */
  async retryAgent(messageId: MessageId): Promise<void> {
    try {
      const { message } = await this.#api.retryAgent(messageId);
      if (message.agentRequest === undefined) return;
      const request = message.agentRequest;
      this.#forEachConversationOf(message.channelId, (key, conversation) => {
        this.#setConversation(key, {
          ...conversation,
          messages: applyAgentRequest(conversation.messages, message.id, request),
        });
      });
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not ask the Agent again", body: describe(cause) });
    }
  }

  /** Optimistic reaction toggle, reconciled against the server's authoritative list. */
  async toggleReaction(message: Message, emoji: string): Promise<void> {
    const me = this.#state.me;
    if (me === null) return;
    const had = message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.userIds.includes(me.id),
    );
    // Adding is a preference; removing one is not, so only the add feeds the quick-pick row.
    if (!had) recordEmojiUse(emoji);
    const optimistic = toggleReaction(message.reactions, emoji, me.id);
    this.#forEachConversationOf(message.channelId, (key, conversation) => {
      this.#setConversation(key, {
        ...conversation,
        messages: applyReactions(conversation.messages, message.id, optimistic),
      });
    });
    try {
      const response = had
        ? await this.#api.removeReaction(message.id, emoji)
        : await this.#api.addReaction(message.id, emoji);
      this.#forEachConversationOf(response.channelId, (key, conversation) => {
        this.#setConversation(key, {
          ...conversation,
          messages: applyReactions(conversation.messages, response.messageId, response.reactions),
        });
      });
    } catch (cause) {
      this.#forEachConversationOf(message.channelId, (key, conversation) => {
        this.#setConversation(key, {
          ...conversation,
          messages: applyReactions(conversation.messages, message.id, message.reactions),
        });
      });
      this.#toast({ tone: "error", title: "Could not add the reaction", body: describe(cause) });
    }
  }

  // --- unread ---------------------------------------------------------------

  setActive(channelId: ChannelId | null, rootId: MessageId | null = null): void {
    if (this.#state.activeChannelId === channelId && this.#state.activeRootId === rootId) return;
    this.#patch({ activeChannelId: channelId, activeRootId: rootId });
    if (channelId !== null) this.#maybeMarkRead(channelId);
  }

  setAtBottom(channelId: ChannelId, rootId: MessageId | null, atBottom: boolean): void {
    const key = conversationKey(channelId, rootId);
    const conversation = this.#state.conversations[key];
    if (conversation === undefined || conversation.atBottom === atBottom) return;
    this.#setConversation(key, { ...conversation, atBottom });
    if (atBottom) this.#maybeMarkRead(channelId);
  }

  setVisible(visible: boolean): void {
    if (this.#state.visible === visible) return;
    this.#patch({ visible });
    if (visible && this.#state.activeChannelId !== null) {
      this.#maybeMarkRead(this.#state.activeChannelId);
    }
  }

  setFocused(focused: boolean): void {
    if (this.#state.focused === focused) return;
    this.#patch({ focused });
    if (focused && this.#state.activeChannelId !== null) {
      this.#maybeMarkRead(this.#state.activeChannelId);
    }
  }

  /**
   * The plan's three conditions, in one place: visible, focused, and scrolled to the bottom. Anything
   * less keeps the "New messages" line where it is.
   */
  #maybeMarkRead(channelId: ChannelId): void {
    const state = this.#state;
    if (!state.visible || !state.focused) return;
    if (state.activeChannelId !== channelId) return;
    const conversation = state.conversations[conversationKey(channelId, state.activeRootId)];
    if (conversation === undefined || !conversation.atBottom) return;
    const channel = state.channels[channelId];
    const membership = state.memberships[channelId];
    if (channel === undefined || membership === undefined) return;
    if (membership.lastReadSeq >= channel.lastSeq && membership.manualUnreadSeq === null) return;
    void this.markRead(channelId, channel.lastSeq);
  }

  async markRead(channelId: ChannelId, seq: number): Promise<void> {
    const membership = this.#state.memberships[channelId];
    const channel = this.#state.channels[channelId];
    if (membership === undefined || channel === undefined) return;
    this.#patch({
      memberships: {
        ...this.#state.memberships,
        [channelId]: applyRead(membership, seq, channel.lastSeq),
      },
      badges:
        seq >= channel.lastSeq
          ? clearChannelBadges(this.#state.badges, channelId)
          : this.#state.badges,
    });
    this.#updateTitle();
    this.#socket.send({ t: "read", channel: channelId, seq });
    try {
      const response = await this.#api.markRead(channelId, { seq });
      this.#patch({
        memberships: { ...this.#state.memberships, [channelId]: response.membership },
        badges: response.badges,
      });
      this.#updateTitle();
    } catch {
      // The socket `read` is the primary path; the HTTP call is belt and braces. A failure here
      // resolves itself on the next reconnect's catch-up, so it is not worth a toast.
    }
  }

  /** "Mark unread from here": the separate manual marker, never a backwards `lastReadSeq`. */
  async markUnreadFrom(channelId: ChannelId, seq: number): Promise<void> {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined) return;
    this.#patch({
      memberships: {
        ...this.#state.memberships,
        [channelId]: { ...membership, manualUnreadSeq: seq },
      },
    });
    try {
      const response = await this.#api.markRead(channelId, { manualUnreadSeq: seq });
      this.#patch({
        memberships: { ...this.#state.memberships, [channelId]: response.membership },
        badges: response.badges,
      });
      this.#updateTitle();
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not mark as unread", body: describe(cause) });
    }
    this.#toast({ tone: "info", title: "Marked unread from here" });
  }

  async clearManualUnread(channelId: ChannelId): Promise<void> {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined || membership.manualUnreadSeq === null) return;
    this.#patch({
      memberships: { ...this.#state.memberships, [channelId]: { ...membership, manualUnreadSeq: null } },
    });
    try {
      await this.#api.markRead(channelId, { manualUnreadSeq: null });
    } catch {
      /* Harmless: the marker reappears on the next channel list refresh. */
    }
  }

  firstUnread(channelId: ChannelId): number | null {
    return firstUnreadSeq(
      this.#state.memberships[channelId],
      this.#state.channels[channelId]?.lastSeq ?? 0,
    );
  }

  #updateTitle(): void {
    const totals = badgeTotals(this.#state.badges, this.#state.memberships);
    if (typeof document !== "undefined") document.title = documentTitle(totals);
    this.onBadgeChange?.(totals.unread, totals.mentions);
  }

  /** Set by the embed bridge, which forwards the totals to the shell. */
  onBadgeChange: ((unread: number, mentions: number) => void) | null = null;

  // --- conversation preferences --------------------------------------------

  async setNotify(channelId: ChannelId, notify: NotifyLevel): Promise<void> {
    await this.#applyMembershipPatch(channelId, { notify }, "Could not change notifications");
  }

  async toggleMute(channelId: ChannelId): Promise<void> {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined) return;
    await this.setMuted(channelId, !membership.muted);
  }

  /** The explicit form, for `/mute` and `/unmute`, which say what they want rather than flipping. */
  async setMuted(channelId: ChannelId, muted: boolean): Promise<void> {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined || membership.muted === muted) return;
    await this.#applyMembershipPatch(
      channelId,
      { muted },
      muted ? "Could not mute this conversation" : "Could not unmute this conversation",
    );
  }

  async toggleStar(channelId: ChannelId): Promise<void> {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined) return;
    await this.#applyMembershipPatch(
      channelId,
      { starred: !membership.starred },
      membership.starred ? "Could not remove the star" : "Could not star this conversation",
    );
  }

  /**
   * One `PATCH channels/:id/membership`, applied optimistically and rolled back on refusal.
   *
   * The response carries fresh badges, because muting changes the counts -- and the server also pushes
   * a `badge` frame to this tab's socket, so the two agree either way.
   */
  async #applyMembershipPatch(
    channelId: ChannelId,
    patch: UpdateMembershipRequest,
    failureTitle: string,
  ): Promise<void> {
    const before = this.#state.memberships[channelId];
    if (before === undefined) return;
    this.#patchMembership(channelId, patch);
    this.#updateTitle();
    try {
      const response = await this.#api.updateMembership(channelId, patch);
      this.#patch({
        memberships: { ...this.#state.memberships, [channelId]: response.membership },
        badges: response.badges,
      });
    } catch (cause) {
      this.#patch({ memberships: { ...this.#state.memberships, [channelId]: before } });
      this.#toast({ tone: "error", title: failureTitle, body: describe(cause) });
    }
    this.#updateTitle();
  }

  #patchMembership(channelId: ChannelId, patch: Partial<Membership>): void {
    const membership = this.#state.memberships[channelId];
    if (membership === undefined) return;
    this.#patch({
      memberships: { ...this.#state.memberships, [channelId]: { ...membership, ...patch } },
    });
  }

  // --- channels -------------------------------------------------------------

  async refreshChannels(): Promise<void> {
    try {
      const response = await this.#api.listChannels();
      this.#patch({
        channels: byId(response.channels),
        memberships: byChannel(response.memberships),
        users: { ...this.#state.users, ...byId(response.users) },
        badges: response.badges,
      });
      this.#updateTitle();
      this.#subscribeAll();
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not refresh channels", body: describe(cause) });
    }
  }

  async createChannel(request: {
    kind: ChannelKind;
    name?: string;
    topic?: string;
    purpose?: string;
    memberIds?: readonly UserId[];
  }): Promise<Channel | null> {
    try {
      const response = await this.#api.createChannel(request);
      this.#applyChannelResponse(response.channel, response.membership);
      return response.channel;
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not create the channel", body: describe(cause) });
      return null;
    }
  }

  async updateChannel(
    channelId: ChannelId,
    patch: { name?: string; topic?: string | null; purpose?: string | null },
  ): Promise<void> {
    try {
      const response = await this.#api.updateChannel(channelId, patch);
      this.#applyChannelResponse(response.channel, response.membership);
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not save the channel", body: describe(cause) });
    }
  }

  async joinChannel(channelId: ChannelId): Promise<void> {
    try {
      const response = await this.#api.joinChannel(channelId);
      this.#applyChannelResponse(response.channel, response.membership);
      this.#subscribeAll();
      this.#toast({ tone: "success", title: `Joined ${channelLabel(response.channel, this.#state.users, this.#state.me?.id)}` });
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not join", body: describe(cause) });
    }
  }

  async leaveChannel(channelId: ChannelId): Promise<void> {
    try {
      const response = await this.#api.leaveChannel(channelId);
      const memberships = { ...this.#state.memberships };
      delete memberships[channelId];
      this.#patch({
        channels: { ...this.#state.channels, [channelId]: response.channel },
        memberships,
      });
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not leave", body: describe(cause) });
    }
  }

  async archiveChannel(channelId: ChannelId): Promise<void> {
    try {
      const response = await this.#api.archiveChannel(channelId);
      this.#applyChannelResponse(response.channel, response.membership);
      if (response.systemMessage !== undefined) this.#receive(response.systemMessage);
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not archive", body: describe(cause) });
    }
  }

  /** Opens the DM with one person, creating it the first time. Returns the channel id to navigate to. */
  async openDm(userId: UserId): Promise<ChannelId | null> {
    const existing = Object.values(this.#state.channels).find(
      (channel) =>
        channel.kind === "dm" &&
        channel.memberIds !== undefined &&
        channel.memberIds.includes(userId) &&
        channel.memberIds.length <= 2,
    );
    if (existing !== undefined) return existing.id;
    const channel = await this.createChannel({ kind: "dm", memberIds: [userId] });
    return channel?.id ?? null;
  }

  #applyChannelResponse(channel: Channel, membership: Membership | null): void {
    const known = this.#state.channels[channel.id] !== undefined;
    const memberships = { ...this.#state.memberships };
    if (membership === null) delete memberships[channel.id];
    else memberships[channel.id] = membership;
    this.#patch({
      channels: { ...this.#state.channels, [channel.id]: channel },
      memberships,
    });
    // A `sub` is a filter over the channels the socket named, so a conversation created (or joined)
    // after the socket connected is invisible to it until the list is sent again -- no `msg`, no
    // `read`, no `typing`. Creating a DM and then never seeing the other person reply is the case
    // that found this.
    if (!known || membership !== null) this.#subscribeAll();
  }

  // --- threads --------------------------------------------------------------

  async loadThreads(): Promise<void> {
    this.#patch({ threadsLoading: true });
    try {
      const response = await this.#api.listThreads({});
      this.#mergeUsers(response.users);
      this.#patch({ threads: response.threads, threadsLoading: false });
    } catch {
      // Threads is one view; a failure there must not break the app, and the view shows its own retry.
      this.#patch({ threadsLoading: false });
    }
  }

  async setFollowing(rootId: MessageId, following: boolean): Promise<void> {
    const before = this.#state.threads;
    this.#patch({
      threads: before.map((thread) => (thread.rootId === rootId ? { ...thread, following } : thread)),
    });
    try {
      const response = following
        ? await this.#api.followThread(rootId)
        : await this.#api.unfollowThread(rootId);
      this.#patch({
        threads: this.#state.threads.map((thread) =>
          thread.rootId === rootId ? response.thread : thread,
        ),
      });
    } catch (cause) {
      this.#patch({ threads: before });
      this.#toast({ tone: "error", title: "Could not change the thread", body: describe(cause) });
    }
  }

  threadSummary(rootId: MessageId): ThreadSummary | undefined {
    return this.#state.threads.find((thread) => thread.rootId === rootId);
  }

  // --- search ---------------------------------------------------------------

  async runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    this.#patch({ search: { query, running: trimmed.length > 0, result: null, error: null } });
    if (trimmed.length === 0) return;
    try {
      const result = await this.#api.search(trimmed);
      this.#mergeUsers(result.users);
      // A slower earlier query must not overwrite a newer one.
      if (this.#state.search.query !== query) return;
      this.#patch({ search: { query, running: false, result, error: null } });
    } catch (cause) {
      if (this.#state.search.query !== query) return;
      this.#patch({ search: { query, running: false, result: null, error: describe(cause) } });
    }
  }

  async loadDirectory(): Promise<void> {
    if (this.#state.directory.loading) return;
    this.#patch({ directory: { ...this.#state.directory, loading: true } });
    try {
      let cursor: string | undefined;
      const seen: User[] = [];
      for (let page = 0; page < 20; page++) {
        const response = await this.#api.listUsers(cursor);
        seen.push(...response.users);
        if (response.cursor === null) break;
        cursor = response.cursor;
      }
      this.#mergeUsers(seen);
      this.#patch({ directory: { loading: false, loaded: true } });
    } catch (cause) {
      this.#patch({ directory: { loading: false, loaded: false } });
      this.#toast({ tone: "error", title: "Could not load the directory", body: describe(cause) });
    }
  }

  // --- drafts and uploads ---------------------------------------------------

  setDraft(key: string, body: string): void {
    const drafts = { ...this.#state.drafts };
    if (body.trim().length === 0) delete drafts[key];
    else drafts[key] = { body, updatedAt: Date.now() };
    this.#patch({ drafts });
    // Debounced: a keystroke-per-write would hit localStorage on every character.
    if (this.#draftFlush !== null) clearTimeout(this.#draftFlush);
    this.#draftFlush = setTimeout(() => {
      this.#draftFlush = null;
      saveDrafts(this.#state.drafts);
    }, 400);
  }

  discardDraft(key: string): void {
    this.setDraft(key, "");
    const uploads = { ...this.#state.uploads };
    for (const upload of uploads[key] ?? []) {
      if (upload.previewUrl !== null) URL.revokeObjectURL(upload.previewUrl);
    }
    delete uploads[key];
    this.#patch({ uploads });
  }

  /** Queues a paste or drop and starts the upload immediately, so progress is visible. */
  async queueUpload(channelId: ChannelId, key: string, file: File): Promise<void> {
    const queued = this.#state.uploads[key] ?? [];
    if (queued.length >= this.#state.limits.maxAttachmentsPerMessage) {
      this.#toast({
        tone: "error",
        title: "Too many attachments",
        body: `At most ${this.#state.limits.maxAttachmentsPerMessage} per message.`,
      });
      return;
    }
    if (file.size > this.#state.limits.maxUploadBytes) {
      this.#toast({
        tone: "error",
        title: `${file.name} is too large`,
        body: `The limit is ${Math.floor(this.#state.limits.maxUploadBytes / (1024 * 1024))} MB.`,
      });
      return;
    }
    const uploadKey = newId();
    const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    const item: QueuedUpload = {
      key: uploadKey,
      name: file.name,
      bytes: file.size,
      mime: file.type,
      previewUrl,
      progress: 0,
      state: "uploading",
      attachment: null,
      error: null,
    };
    this.#setUploads(key, [...queued, item]);

    try {
      const attachment = await this.#api.upload(channelId, file, {
        onProgress: ({ loaded, total }) =>
          this.#updateUpload(key, uploadKey, {
            progress: total === 0 ? 0 : Math.min(1, loaded / total),
          }),
      });
      this.#updateUpload(key, uploadKey, { state: "ready", progress: 1, attachment });
    } catch (cause) {
      this.#updateUpload(key, uploadKey, { state: "failed", error: describe(cause) });
    }
  }

  removeUpload(key: string, uploadKey: string): void {
    const queued = this.#state.uploads[key] ?? [];
    const target = queued.find((upload) => upload.key === uploadKey);
    if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
    this.#setUploads(
      key,
      queued.filter((upload) => upload.key !== uploadKey),
    );
  }

  #setUploads(key: string, uploads: readonly QueuedUpload[]): void {
    this.#patch({ uploads: { ...this.#state.uploads, [key]: uploads } });
  }

  #updateUpload(key: string, uploadKey: string, patch: Partial<QueuedUpload>): void {
    this.#setUploads(
      key,
      (this.#state.uploads[key] ?? []).map((upload) =>
        upload.key === uploadKey ? { ...upload, ...patch } : upload,
      ),
    );
  }

  typingIn(channelId: ChannelId): void {
    this.#socket.send({ t: "typing", channel: channelId });
  }

  // --- notifications --------------------------------------------------------

  /**
   * In-app toast when the conversation is not on screen; a browser notification when the tab is hidden
   * and the user has opted in; when embedded, the shell's toast in both cases. Deduplicated by message
   * id across every path.
   */
  #maybeNotify(message: Message): void {
    const state = this.#state;
    const me = state.me;
    if (me === null) return;
    if (this.#notified.has(message.id)) return;
    if (!shouldNotify(message, me.id, state.memberships[message.channelId])) return;

    const onScreen =
      state.visible &&
      state.activeChannelId === message.channelId &&
      (message.rootId === null || state.activeRootId === message.rootId);
    if (onScreen && state.focused) return;

    this.#notified.add(message.id);
    const author = state.users[message.authorId]?.name ?? "Someone";
    const channel = state.channels[message.channelId];
    const where = channel === undefined ? "" : ` in ${channelLabel(channel, state.users, me.id)}`;
    const preview = mentionsToText(
      toPlainText(message.body),
      (id) => state.users[id]?.name,
      (id) => state.channels[id]?.name ?? undefined,
    );
    const href = permalink(message.channelId, message.id);

    this.#patch({ announcement: `${author}${where}: ${preview}` });

    // Embedded, the shell shows the toast: this frame may be in a closed drawer (display: none, which
    // still reports a visible document), and the shell's toast is on screen either way.
    if (this.#state.embedded || (typeof document !== "undefined" && document.visibilityState === "hidden")) {
      this.#systemNotify(`${author}${where}`, preview, href);
      return;
    }
    this.#toast({
      tone: "info",
      title: `${author}${where}`,
      body: preview,
      href,
    });
  }

  #systemNotify(title: string, body: string, href: string): void {
    if (this.#state.embedded) {
      this.onNotify?.(title, body, href);
      return;
    }
    if (!this.#state.notificationsOptIn) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const notification = new Notification(title, { body, tag: href });
      notification.addEventListener("click", () => {
        window.focus();
        this.#navigate(href);
        notification.close();
      });
    } catch {
      // Some browsers throw for constructor notifications when a service worker is required. The
      // in-app toast is the fallback, and phase 3 adds the service worker.
      this.#toast({ tone: "info", title, body, href });
    }
  }

  /** Set by the embed bridge, so a notification becomes a Kumo toast in the shell instead. */
  onNotify: ((title: string, body: string, href: string) => void) | null = null;

  /**
   * The permission prompt, asked only from a user gesture on the settings toggle. Never on load: an
   * unprompted permission request is the thing every browser now penalises.
   */
  async enableNotifications(): Promise<void> {
    if (typeof Notification === "undefined") {
      this.#patch({ notificationPermission: "unsupported" });
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    this.#patch({
      notificationPermission: permission,
      notificationsOptIn: permission === "granted",
    });
    writeSetting(NOTIFY_OPT_IN_KEY, permission === "granted" ? "1" : null);
    if (permission === "denied") {
      this.#toast({
        tone: "error",
        title: "Notifications are blocked",
        body: "Allow notifications for this site in your browser settings.",
      });
    }
  }

  disableNotifications(): void {
    this.#patch({ notificationsOptIn: false });
    writeSetting(NOTIFY_OPT_IN_KEY, null);
  }

  // --- theme, toasts, announcements ----------------------------------------

  setTheme(mode: ThemeMode | null, options: { persist?: boolean } = {}): void {
    this.#patch({ themeOverride: mode, theme: mode ?? systemTheme() });
    if (options.persist !== false) writeSetting(THEME_KEY, mode);
    this.applyTheme();
  }

  applyTheme(): void {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.mode = this.#state.theme;
  }

  /** Called when the OS preference changes and the user has not overridden it. */
  systemThemeChanged(): void {
    if (this.#state.themeOverride !== null) return;
    this.#patch({ theme: systemTheme() });
    this.applyTheme();
  }

  async updatePrefs(patch: { displayName?: string | null; notify?: NotifyLevel }): Promise<void> {
    try {
      const response = await this.#api.updateMe(patch);
      this.#patch({
        me: response.user,
        prefs: response.prefs,
        users: { ...this.#state.users, [response.user.id]: response.user },
      });
      this.#toast({ tone: "success", title: "Settings saved" });
    } catch (cause) {
      this.#toast({ tone: "error", title: "Could not save settings", body: describe(cause) });
    }
  }

  toast(toast: Omit<Toast, "id" | "timeout"> & { timeout?: number | null }): void {
    this.#toast(toast);
  }

  #toast(toast: Omit<Toast, "id" | "timeout"> & { timeout?: number | null }): void {
    const id = newId();
    const timeout =
      toast.timeout !== undefined ? toast.timeout : toast.tone === "error" ? null : TOAST_TIMEOUT_MS;
    // Bounded: a reconnect storm must not stack fifty cards over the composer.
    const toasts = [...this.#state.toasts, { ...toast, id, timeout }].slice(-4);
    this.#patch({ toasts });
    if (timeout !== null) this.#later(() => this.dismissToast(id), timeout);
  }

  dismissToast(id: string): void {
    this.#patch({ toasts: this.#state.toasts.filter((toast) => toast.id !== id) });
  }

  announce(message: string): void {
    this.#patch({ announcement: message });
  }

  // --- internals ------------------------------------------------------------

  /**
   * The page's `readCursors`, for a dm or group.
   *
   * `undefined` means the channel kind does not carry them (public, private) and is not the same as an
   * empty array, which means nobody else has read anything -- so the key is only written when the
   * server sent the field.
   */
  #mergeReadCursors(channelId: ChannelId, cursors: readonly ReadCursor[] | undefined): void {
    if (cursors === undefined) return;
    this.#patch({ readCursors: { ...this.#state.readCursors, [channelId]: cursors } });
  }

  #mergeUsers(users: readonly User[]): void {
    if (users.length === 0) return;
    this.#patch({ users: { ...this.#state.users, ...byId(users) } });
  }

  // --- people this client has not seen -----------------------------------------------------------
  //
  // Live events carry ids, not people: a `typing`, a reaction, a read cursor, a mention. The HTTP pages
  // bring their authors with them, but somebody who signs in after this tab loaded -- and then posts,
  // types or reacts -- is named by an event and by nothing else, and used to render as "Unknown" until
  // a reload. Every id an event names goes through `#noticeUsers`; the unknown ones are batched into
  // `GET /api/users?ids=`, deduplicated against what is already queued or in flight, and an id the
  // directory does not return is left alone for a while rather than asked for on every frame.

  readonly #wantedUsers = new Set<UserId>();
  readonly #missingUsers = new Map<UserId, number>();
  #resolveScheduled = false;

  #noticeUsers(userIds: Iterable<UserId>): void {
    const now = Date.now();
    let added = false;
    for (const id of userIds) {
      if (id.length === 0 || this.#state.users[id] !== undefined || this.#wantedUsers.has(id)) continue;
      if ((this.#missingUsers.get(id) ?? 0) > now) continue;
      this.#wantedUsers.add(id);
      added = true;
    }
    if (!added || this.#resolveScheduled) return;
    this.#resolveScheduled = true;
    this.#later(() => void this.#resolveUsers(), USER_RESOLVE_DELAY_MS);
  }

  async #resolveUsers(): Promise<void> {
    const ids = [...this.#wantedUsers].slice(0, MAX_PAGE_LIMIT);
    let found: readonly User[] | null = null;
    try {
      found = (await this.#api.getUsers(ids)).users;
    } catch {
      // Quietly: nothing the person did failed, and the name arrives with the next event or page.
    }
    const retryAt = Date.now() + (found === null ? FAILED_USER_RETRY_MS : MISSING_USER_RETRY_MS);
    if (found !== null) this.#mergeUsers(found);
    const returned = new Set((found ?? []).map((user) => user.id));
    for (const id of ids) {
      this.#wantedUsers.delete(id);
      if (!returned.has(id)) this.#missingUsers.set(id, retryAt);
    }
    this.#resolveScheduled = false;
    if (this.#wantedUsers.size > 0) {
      this.#resolveScheduled = true;
      this.#later(() => void this.#resolveUsers(), USER_RESOLVE_DELAY_MS);
    }
  }

  /** A reconnect is a fresh start: somebody missing an hour ago may have signed in since. */
  #retryMissingUsers(): void {
    this.#missingUsers.clear();
  }

  #setConversation(key: string, conversation: ConversationState): void {
    this.#patch({ conversations: { ...this.#state.conversations, [key]: conversation } });
  }

  /** Applies a change to the channel conversation and, when the message is a reply, to its thread. */
  #applyToConversations(
    channelId: ChannelId,
    rootId: MessageId | null,
    update: (conversation: ConversationState) => ConversationState,
  ): void {
    const keys = [conversationKey(channelId)];
    if (rootId !== null) keys.push(conversationKey(channelId, rootId));
    for (const key of keys) {
      const conversation = this.#state.conversations[key];
      if (conversation === undefined) continue;
      this.#setConversation(key, update(conversation));
    }
  }

  /** Every loaded conversation belonging to one channel: the channel itself and any open thread. */
  #forEachConversationOf(
    channelId: ChannelId,
    visit: (key: string, conversation: ConversationState) => void,
  ): void {
    for (const [key, conversation] of Object.entries(this.#state.conversations)) {
      if (key === channelId || key.startsWith(`${channelId}:`)) visit(key, conversation);
    }
  }
}

/** Every person a set of messages names: authors, mentions, reactors, askers. */
function userIdsOf(messages: readonly Message[]): UserId[] {
  const ids: UserId[] = [];
  for (const message of messages) {
    ids.push(message.authorId);
    for (const mention of message.mentions) if (mention.kind === "user") ids.push(mention.userId);
    for (const reaction of message.reactions) ids.push(...reaction.userIds);
    if (message.agentRequest !== undefined) ids.push(message.agentRequest.requesterId);
  }
  return ids;
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

function byChannel(memberships: readonly Membership[]): Record<ChannelId, Membership> {
  const out: Record<ChannelId, Membership> = {};
  for (const membership of memberships) out[membership.channelId] = membership;
  return out;
}

function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function notificationPermission(): ChatState["notificationPermission"] {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** A human message for any thrown value, never a stack trace. */
export function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Something went wrong.";
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Local-only helper for the LocalMessage type, re-exported so views need one import. */
export type { LocalMessage };
