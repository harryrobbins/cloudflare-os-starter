// What the store is allowed to know about the network.
//
// Two interfaces, one HTTP and one socket, so the mock transport (`src/mock/`) is a drop-in: the store
// has no branch for "are we mocked", and neither does any component. Every method mirrors one named
// route from `routes.ts`; nothing here invents a path.

import type {
  Attachment,
  ChannelId,
  ChannelListResponse,
  ChannelResponse,
  ClientEvent,
  CreateChannelRequest,
  DeleteMessageResponse,
  ErrorCode,
  ListMessagesQuery,
  ListThreadsQuery,
  MarkReadRequest,
  MarkReadResponse,
  MembershipResponse,
  MeResponse,
  MessageId,
  MessagePageResponse,
  MessageResponse,
  ReactionResponse,
  SearchResult,
  SendMessageRequest,
  SendMessageResponse,
  ServerEvent,
  ThreadListResponse,
  ThreadResponse,
  UpdateChannelRequest,
  UpdateMembershipRequest,
  UpdateMeRequest,
  UserId,
  UserListResponse,
  UserResponse,
} from "../contract.js";

/**
 * A failed request, carrying the contract's error code so callers switch on a closed set rather than
 * on a status number or a message string.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True for the codes where offering "Retry" makes sense. */
  get retryable(): boolean {
    return this.code === "internal" || this.code === "rate_limited" || this.status === 0;
  }
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface ChatApi {
  me(): Promise<MeResponse>;
  updateMe(request: UpdateMeRequest): Promise<UserResponse>;

  listChannels(): Promise<ChannelListResponse>;
  createChannel(request: CreateChannelRequest): Promise<ChannelResponse>;
  updateChannel(channelId: ChannelId, request: UpdateChannelRequest): Promise<ChannelResponse>;
  joinChannel(channelId: ChannelId): Promise<ChannelResponse>;
  leaveChannel(channelId: ChannelId): Promise<ChannelResponse>;
  archiveChannel(channelId: ChannelId): Promise<ChannelResponse>;
  markRead(channelId: ChannelId, request: MarkReadRequest): Promise<MarkReadResponse>;
  /** The caller's own `notify` / `muted` / `starred` on one conversation. */
  updateMembership(
    channelId: ChannelId,
    request: UpdateMembershipRequest,
  ): Promise<MembershipResponse>;

  listMessages(channelId: ChannelId, query?: ListMessagesQuery): Promise<MessagePageResponse>;
  sendMessage(channelId: ChannelId, request: SendMessageRequest): Promise<SendMessageResponse>;
  editMessage(messageId: MessageId, body: string): Promise<MessageResponse>;
  deleteMessage(messageId: MessageId): Promise<DeleteMessageResponse>;
  addReaction(messageId: MessageId, emoji: string): Promise<ReactionResponse>;
  /** Asks the Agent again after a failure. Only the person who asked may. */
  retryAgent(messageId: MessageId): Promise<MessageResponse>;
  removeReaction(messageId: MessageId, emoji: string): Promise<ReactionResponse>;

  listThreads(query?: ListThreadsQuery): Promise<ThreadListResponse>;
  followThread(rootId: MessageId): Promise<ThreadResponse>;
  unfollowThread(rootId: MessageId): Promise<ThreadResponse>;

  search(q: string, cursor?: string): Promise<SearchResult>;

  upload(
    channelId: ChannelId,
    file: File,
    options?: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal },
  ): Promise<Attachment>;

  listUsers(cursor?: string): Promise<UserListResponse>;
  getUser(userId: UserId): Promise<{ user: import("../contract.js").User }>;
}

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ChatSocket {
  /** Opens the socket and keeps it open, reconnecting with jittered backoff until `close()`. */
  open(): void;
  close(): void;
  send(event: ClientEvent): void;
  /** Current transport state, for the offline banner. */
  status(): SocketStatus;
  /** Seconds until the next reconnect attempt, when `status()` is `reconnecting`. */
  retryInSeconds(): number | null;
  onEvent(listener: (event: ServerEvent) => void): () => void;
  onStatus(listener: (status: SocketStatus) => void): () => void;
}

export interface Transport {
  readonly api: ChatApi;
  readonly socket: ChatSocket;
  /** Present only in the mock transport: lets the dev tools drive the fake. */
  readonly mock?: MockControls;
}

/** The handful of levers the mock exposes, so a screenshot run can stage a scenario deterministically. */
export interface MockControls {
  /** Delivers a message from somebody else, as if it arrived over the socket. */
  injectMessage(channelId: ChannelId, authorId: UserId, body: string): void;
  setOnline(userIds: readonly UserId[]): void;
  startTyping(channelId: ChannelId, userId: UserId): void;
  /** Fakes a dropped connection so the reconnecting banner can be photographed. */
  setConnected(connected: boolean): void;
  /** Makes the next N writes fail, to exercise the failed/retry path. */
  failNextWrites(count: number, code?: ErrorCode): void;
}
