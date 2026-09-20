// The shape of everything the UI reads. Split from `store.ts` so the tests and the components can name
// the state without importing the class that mutates it.

import type {
  Attachment,
  BadgeSummary,
  Channel,
  ChannelId,
  Membership,
  MessageId,
  ReadCursor,
  SearchResult,
  ThreadSummary,
  User,
  UserId,
  UserPrefs,
} from "../contract.js";
import type { SocketStatus } from "../api/types.js";
import type { Draft } from "./drafts.js";
import type { LocalMessage } from "./merge.js";

export type ThemeMode = "light" | "dark";

export interface ConversationState {
  readonly messages: readonly LocalMessage[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  /** True while the first page is in flight; drives the skeleton rather than a spinner. */
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  /** Set when a permalink brought us here, so the row can be highlighted once and then released. */
  readonly focusMessageId: MessageId | null;
  /** True while the list is scrolled to the bottom, which is one of the three read conditions. */
  readonly atBottom: boolean;
}

export const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  hasMoreBefore: false,
  hasMoreAfter: false,
  loading: false,
  loadingOlder: false,
  loaded: false,
  error: null,
  focusMessageId: null,
  atBottom: true,
};

export type UploadState = "uploading" | "ready" | "failed";

export interface QueuedUpload {
  /** Local id: the attachment id once the upload commits, a temporary one before that. */
  readonly key: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  /** Object URL for an image, so the thumbnail appears before the upload finishes. */
  readonly previewUrl: string | null;
  readonly progress: number;
  readonly state: UploadState;
  readonly attachment: Attachment | null;
  readonly error: string | null;
}

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Toast {
  readonly id: string;
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly body?: string;
  /** Clicking the toast navigates here. Permalinks come from `permalink()`, never a literal. */
  readonly href?: string;
  readonly action?: ToastAction;
  /** Milliseconds before it dismisses itself; errors stay until dismissed. */
  readonly timeout: number | null;
}

export interface SearchState {
  readonly query: string;
  readonly running: boolean;
  readonly result: SearchResult | null;
  readonly error: string | null;
}

export interface ChatState {
  readonly phase: "loading" | "ready" | "error";
  readonly fatalError: string | null;

  readonly me: User | null;
  readonly prefs: UserPrefs;
  readonly admin: boolean;
  readonly limits: {
    readonly maxBodyBytes: number;
    readonly maxUploadBytes: number;
    readonly maxAttachmentsPerMessage: number;
  };

  readonly channels: Readonly<Record<ChannelId, Channel>>;
  readonly memberships: Readonly<Record<ChannelId, Membership>>;
  readonly users: Readonly<Record<UserId, User>>;
  readonly online: readonly UserId[];
  readonly badges: BadgeSummary;
  /**
   * How far the *other* members of a `dm` or `group` have read, keyed by channel.
   *
   * Only those two kinds: `GET channels/:id/messages` omits `readCursors` for `public` and `private`
   * (a channel can hold the whole deployment), so a missing entry means "not a thing here", not
   * "nobody has read".
   */
  readonly readCursors: Readonly<Record<ChannelId, readonly ReadCursor[]>>;

  readonly conversations: Readonly<Record<string, ConversationState>>;
  readonly threads: readonly ThreadSummary[];
  readonly threadsLoading: boolean;

  /** Keyed by the conversation key (`channelId` or `channelId:rootId`). */
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly uploads: Readonly<Record<string, readonly QueuedUpload[]>>;

  readonly search: SearchState;
  readonly directory: { readonly loading: boolean; readonly loaded: boolean };

  readonly socketStatus: SocketStatus;
  /** Null unless reconnecting. Counted down by the banner. */
  readonly retryInSeconds: number | null;
  /** Per channel, the users typing right now with their expiry timestamps. */
  readonly typing: Readonly<Record<ChannelId, Readonly<Record<UserId, number>>>>;

  readonly toasts: readonly Toast[];
  /** Announced by the aria-live region. Replaced, never appended to, so focus never moves. */
  readonly announcement: string;

  readonly theme: ThemeMode;
  /** Explicit user or shell choice; null means follow `prefers-color-scheme`. */
  readonly themeOverride: ThemeMode | null;
  readonly notificationsOptIn: boolean;
  readonly notificationPermission: "default" | "granted" | "denied" | "unsupported";

  readonly embedded: boolean;
  readonly visible: boolean;
  readonly focused: boolean;
  /** The conversation the UI currently shows, so notifications know what is on screen. */
  readonly activeChannelId: ChannelId | null;
  readonly activeRootId: MessageId | null;
}

export const INITIAL_STATE: ChatState = {
  phase: "loading",
  fatalError: null,
  me: null,
  prefs: { displayName: null, tz: null, notify: "all" },
  admin: false,
  limits: { maxBodyBytes: 8192, maxUploadBytes: 10 * 1024 * 1024, maxAttachmentsPerMessage: 10 },
  channels: {},
  memberships: {},
  users: {},
  online: [],
  badges: { unread: {}, mentions: {}, threads: 0 },
  readCursors: {},
  conversations: {},
  threads: [],
  threadsLoading: false,
  drafts: {},
  uploads: {},
  search: { query: "", running: false, result: null, error: null },
  directory: { loading: false, loaded: false },
  socketStatus: "idle",
  retryInSeconds: null,
  typing: {},
  toasts: [],
  announcement: "",
  theme: "light",
  themeOverride: null,
  notificationsOptIn: false,
  notificationPermission: "default",
  embedded: false,
  visible: true,
  focused: true,
  activeChannelId: null,
  activeRootId: null,
};
