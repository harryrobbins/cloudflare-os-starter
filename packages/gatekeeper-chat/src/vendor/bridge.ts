// How the Gatekeeper vendor reaches the chat data.
//
// The vendor never opens the Durable Object's SQLite database itself. It calls the same internal
// HTTP API the browser calls, as the built-in `agent` account, so every rule the Durable Object
// enforces for a person -- membership, archiving, rate limits, idempotency -- applies unchanged to
// the agent. There is exactly one place (`ChatWorkspace.fetch`) where a read or write can be
// refused, and the vendor is on the far side of it.
//
// The identity header is set the same way `src/serve.ts` sets it, and for the same reason: the
// object has no route of its own, so the only callers are this Worker's own bindings. Nothing here
// goes through `serveChat()`, which is deliberate -- its `Origin` check exists to stop a browser on
// another site from driving the API with somebody's Access cookie, and there is no browser here.

import type { ChatEnv } from "../env.js";
import {
  AGENT_USER_ID,
  AGENT_USER_NAME,
  ERROR_CODES,
  IDENTITY_HEADER,
  type ChannelListResponse,
  type ChatIdentity,
  type DeleteMessageResponse,
  type ErrorCode,
  type MessagePageResponse,
  type SearchResult,
  type SendMessageRequest,
  type SendMessageResponse,
  type UserKind,
} from "../shared/protocol.js";
import { apiPath } from "../shared/routes.js";
import { WORKSPACE_NAME } from "../serve.js";

/**
 * The identity every vendor call acts as.
 *
 * `agent` is a reserved user id, not an Access subject: nobody can sign in as it, and the Durable
 * Object treats it as an implicit member of every public channel and as a member of nothing else.
 * The email is a stable synthetic address so the directory row has one; it is never delivered to.
 */
export const AGENT_IDENTITY: ChatIdentity & { readonly kind: UserKind } = {
  id: AGENT_USER_ID,
  email: "agent@chat.local",
  name: AGENT_USER_NAME,
  kind: "agent",
};

/** The `GET /api/channels/:channelId/messages` parameters the vendor uses. */
export interface BridgeMessageQuery {
  /** Highest sequence number to exclude, i.e. page backwards from here. */
  readonly before?: number;
  /** Restrict the page to one thread. */
  readonly rootId?: string;
  readonly limit: number;
}

/** The `GET /api/search` parameters the vendor uses. */
export interface BridgeSearchQuery {
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The chat API, as the vendor needs it.
 *
 * An interface rather than a concrete class so the session and the action handlers can be tested
 * without a Durable Object: the unit tests inject a recording stub (streams A and B are still
 * filling the routes in, and until they land every one of them answers `501 not_implemented`).
 */
export interface ChatBridge {
  /** Every channel the agent can see, plus the directory entries those channels reference. */
  listChannels(): Promise<ChannelListResponse>;
  listMessages(channelId: string, query: BridgeMessageQuery): Promise<MessagePageResponse>;
  search(query: string, options: BridgeSearchQuery): Promise<SearchResult>;
  sendMessage(channelId: string, request: SendMessageRequest): Promise<SendMessageResponse>;
  deleteMessage(messageId: string): Promise<DeleteMessageResponse>;
}

/** An error the chat API answered with, carrying its contract error code. */
export class ChatApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number, message: string) {
    super(message);
    this.name = "ChatApiError";
    this.code = code;
    this.status = status;
  }
}

/** Calls the `ChatWorkspace` Durable Object over its internal HTTP API as the agent. */
export class WorkspaceBridge implements ChatBridge {
  readonly #env: Pick<ChatEnv, "CHAT_WORKSPACE">;

  constructor(env: Pick<ChatEnv, "CHAT_WORKSPACE">) {
    this.#env = env;
  }

  listChannels(): Promise<ChannelListResponse> {
    return this.#call<ChannelListResponse>("GET", apiPath("listChannels"));
  }

  listMessages(channelId: string, query: BridgeMessageQuery): Promise<MessagePageResponse> {
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.before !== undefined) params.set("before", String(query.before));
    if (query.rootId !== undefined) params.set("rootId", query.rootId);
    return this.#call<MessagePageResponse>(
      "GET",
      `${apiPath("listMessages", { channelId })}?${params.toString()}`,
    );
  }

  search(query: string, options: BridgeSearchQuery): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query, limit: String(options.limit) });
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.#call<SearchResult>("GET", `${apiPath("search")}?${params.toString()}`);
  }

  sendMessage(channelId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    return this.#call<SendMessageResponse>(
      "POST",
      apiPath("sendMessage", { channelId }),
      request,
    );
  }

  deleteMessage(messageId: string): Promise<DeleteMessageResponse> {
    return this.#call<DeleteMessageResponse>("DELETE", apiPath("deleteMessage", { messageId }));
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers({ [IDENTITY_HEADER]: JSON.stringify(AGENT_IDENTITY) });
    if (body !== undefined) headers.set("content-type", "application/json");

    // The host is arbitrary: a Durable Object stub routes by stub, not by URL, and only the path is
    // read. `https://chat` keeps it obvious in a log that the request never left the Worker.
    const request = new Request(`https://chat${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const stub = this.#env.CHAT_WORKSPACE.get(this.#env.CHAT_WORKSPACE.idFromName(WORKSPACE_NAME));
    const response = await stub.fetch(request);
    if (!response.ok) throw await chatApiError(response);
    return (await response.json()) as T;
  }
}

/** Turns an error response into an exception the agent can act on. */
export async function chatApiError(response: Response): Promise<ChatApiError> {
  let code: ErrorCode = "internal";
  let message = `Team chat answered ${response.status}.`;
  try {
    const parsed: unknown = await response.json();
    const envelope =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? (parsed as { error: unknown }).error
        : null;
    if (typeof envelope === "object" && envelope !== null) {
      const raw = envelope as { code?: unknown; message?: unknown };
      if (typeof raw.code === "string" && (ERROR_CODES as readonly string[]).includes(raw.code)) {
        code = raw.code as ErrorCode;
      }
      if (typeof raw.message === "string" && raw.message.length > 0) message = raw.message;
    }
  } catch {
    // A non-JSON body is not worth reporting twice; the status and code already say enough.
  }
  const hint =
    code === "not_implemented"
      ? " This part of the chat API has not shipped in this deployment yet."
      : "";
  return new ChatApiError(code, response.status, `${message}${hint}`);
}
