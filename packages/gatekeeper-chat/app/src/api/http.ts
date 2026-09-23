// The real HTTP client. Every URL comes from `apiPath()`; there is no string concatenation of paths
// anywhere in the app.

import {
  apiPath,
  type Attachment,
  type ChannelId,
  type ChannelListResponse,
  type ChannelResponse,
  type CreateChannelRequest,
  type DeleteMessageResponse,
  type ErrorCode,
  type ListMessagesQuery,
  type ListThreadsQuery,
  type MarkReadRequest,
  type MarkReadResponse,
  type MembershipResponse,
  type MeResponse,
  type MessageId,
  type MessagePageResponse,
  type MessageResponse,
  type ReactionResponse,
  type SearchResult,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadListResponse,
  type ThreadResponse,
  type UpdateChannelRequest,
  type UpdateMembershipRequest,
  type UpdateMeRequest,
  type UploadResponse,
  type User,
  type UserId,
  type UserListResponse,
  type UserResponse,
} from "../contract.js";
import { ApiError, type ChatApi, type UploadProgress } from "./types.js";

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : "";
}

/**
 * One request.
 *
 * A non-2xx body is expected to be an `ErrorEnvelope`; anything else (an HTML error page from an
 * intermediary, an empty 502) still has to become an `ApiError` with a usable code, so the status is
 * mapped as a fallback. A network failure becomes status 0, which `ApiError.retryable` treats as
 * retryable -- that is the offline case.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Cookie-authenticated same-origin requests; never send credentials cross-origin.
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError("internal", "The network is unavailable.", 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const envelope =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (parsed as { error: { code?: string; message?: string; retryAfter?: number } }).error
        : undefined;
    throw new ApiError(
      codeForStatus(envelope?.code, response.status),
      envelope?.message ?? `Request failed (${response.status}).`,
      response.status,
      envelope?.retryAfter,
    );
  }
  return parsed as T;
}

const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  501: "not_implemented",
};

function codeForStatus(code: string | undefined, status: number): ErrorCode {
  if (code !== undefined) return code as ErrorCode;
  return STATUS_CODES[status] ?? "internal";
}

export function createHttpApi(): ChatApi {
  return {
    me: () => request<MeResponse>("GET", apiPath("me")),
    updateMe: (body: UpdateMeRequest) => request<UserResponse>("PATCH", apiPath("me"), body),

    listChannels: () => request<ChannelListResponse>("GET", apiPath("listChannels")),
    createChannel: (body: CreateChannelRequest) =>
      request<ChannelResponse>("POST", apiPath("createChannel"), body),
    updateChannel: (channelId: ChannelId, body: UpdateChannelRequest) =>
      request<ChannelResponse>("PATCH", apiPath("updateChannel", { channelId }), body),
    joinChannel: (channelId: ChannelId) =>
      request<ChannelResponse>("POST", apiPath("joinChannel", { channelId })),
    leaveChannel: (channelId: ChannelId) =>
      request<ChannelResponse>("POST", apiPath("leaveChannel", { channelId })),
    archiveChannel: (channelId: ChannelId) =>
      request<ChannelResponse>("POST", apiPath("archiveChannel", { channelId })),
    markRead: (channelId: ChannelId, body: MarkReadRequest) =>
      request<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), body),
    updateMembership: (channelId: ChannelId, body: UpdateMembershipRequest) =>
      request<MembershipResponse>("PATCH", apiPath("updateMembership", { channelId }), body),

    listMessages: (channelId: ChannelId, params: ListMessagesQuery = {}) =>
      request<MessagePageResponse>(
        "GET",
        apiPath("listMessages", { channelId }) +
          query({
            before: params.before,
            after: params.after,
            around: params.around,
            rootId: params.rootId,
            limit: params.limit,
          }),
      ),
    sendMessage: (channelId: ChannelId, body: SendMessageRequest) =>
      request<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), body),
    editMessage: (messageId: MessageId, body: string) =>
      request<MessageResponse>("PATCH", apiPath("editMessage", { messageId }), { body }),
    deleteMessage: (messageId: MessageId) =>
      request<DeleteMessageResponse>("DELETE", apiPath("deleteMessage", { messageId })),
    addReaction: (messageId: MessageId, emoji: string) =>
      request<ReactionResponse>("PUT", apiPath("addReaction", { messageId, emoji })),
    removeReaction: (messageId: MessageId, emoji: string) =>
      request<ReactionResponse>("DELETE", apiPath("removeReaction", { messageId, emoji })),
    retryAgent: (messageId: MessageId) =>
      request<MessageResponse>("POST", apiPath("retryAgent", { messageId })),

    listThreads: (params: ListThreadsQuery = {}) =>
      request<ThreadListResponse>(
        "GET",
        apiPath("listThreads") +
          query({ unread: params.unread, cursor: params.cursor, limit: params.limit }),
      ),
    followThread: (rootId: MessageId) =>
      request<ThreadResponse>("POST", apiPath("followThread", { rootId })),
    unfollowThread: (rootId: MessageId) =>
      request<ThreadResponse>("DELETE", apiPath("unfollowThread", { rootId })),

    search: (q: string, cursor?: string) =>
      request<SearchResult>("GET", apiPath("search") + query({ q, cursor })),

    upload: (channelId, file, options) => upload(channelId, file, options),

    listUsers: (cursor?: string) =>
      request<UserListResponse>("GET", apiPath("listUsers") + query({ cursor })),
    getUser: (userId: UserId) => request<{ user: User }>("GET", apiPath("getUser", { userId })),
  };
}

/**
 * Multipart upload with progress.
 *
 * XMLHttpRequest rather than `fetch`, because a queued attachment shows a progress bar and `fetch`
 * still cannot report upload progress in any shipping browser.
 */
function upload(
  channelId: ChannelId,
  file: File,
  options?: { onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal },
): Promise<Attachment> {
  return new Promise<Attachment>((resolve, reject) => {
    const form = new FormData();
    form.set("channelId", channelId);
    form.set("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiPath("createUpload"));
    xhr.responseType = "text";
    xhr.setRequestHeader("accept", "application/json");
    xhr.withCredentials = false; // Same-origin; cookies travel anyway.

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      options?.onProgress?.({ loaded: event.loaded, total: event.total });
    });

    xhr.addEventListener("error", () => reject(new ApiError("internal", "The upload failed.", 0)));
    xhr.addEventListener("abort", () =>
      reject(new DOMException("The upload was cancelled.", "AbortError")),
    );
    xhr.addEventListener("load", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((parsed as UploadResponse).attachment);
        return;
      }
      const envelope =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? (parsed as { error: { code?: string; message?: string } }).error
          : undefined;
      reject(
        new ApiError(
          codeForStatus(envelope?.code, xhr.status),
          envelope?.message ?? `The upload failed (${xhr.status}).`,
          xhr.status,
        ),
      );
    });

    options?.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
