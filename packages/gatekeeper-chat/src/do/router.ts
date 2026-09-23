// The Durable Object's own router: one named API route to one handler, plus the WebSocket upgrade and
// the authenticated file stream.
//
// Route names come from `shared/routes.ts`, so a path only exists in one place and a client and the
// object cannot disagree about it. Everything an inbound request carries goes through
// `shared/validate.ts` first; every refusal comes back as an {@link Outcome} that this file turns
// into the one error envelope the contract defines.

import { maxUploadBytes } from "../env.js";
import { errorResponse, json } from "../http.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  type MeResponse,
  type OkResponse,
  type UserResponse,
} from "../shared/protocol.js";
import { FILES_PREFIX, matchApiRoute, matchFilePath, WS_PATH, type ApiRouteName } from "../shared/routes.js";
import {
  parseCreateChannel,
  parseEditMessage,
  parseEmoji,
  parseListMessagesQuery,
  parseListThreadsQuery,
  parseMarkRead,
  parseSendMessage,
  parseUpdateMembership,
  parseUpdateChannel,
  parseUpdateMe,
  type Result,
} from "../shared/validate.js";
import {
  archiveChannel,
  createChannel,
  joinChannel,
  leaveChannel,
  listChannels,
  markRead,
  updateChannel,
  updateMembership,
} from "./channels.js";
import type { Ctx, Outcome } from "./context.js";
import { createUpload, serveFile } from "./files.js";
import {
  deleteMessage,
  editMessage,
  listMessages,
  listThreads,
  sendMessage,
  setReaction,
  setThreadFollow,
} from "./messages.js";
import { toPrefs, toUser, type UserRow } from "./rows.js";
import { search } from "./search.js";
import { acceptSocket } from "./sockets.js";
import { badgeSummary } from "./unread.js";
import { isAdmin, listUsers, loadUserRow, updatePrefs, visibleInDirectory } from "./users.js";

/** Turns an {@link Outcome} into the contract's response or its error envelope. */
function respond<T>(outcome: Outcome<T>): Response {
  return outcome.ok
    ? json(outcome.value)
    : errorResponse(outcome.code, outcome.message, outcome.retryAfter);
}

/** Turns a validator's {@link Result} into a 400, or hands the value to a handler. */
function validated<T>(result: Result<T>, handler: (value: T) => Response): Response {
  return result.ok ? handler(result.value) : errorResponse("invalid_request", result.message);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function route(
  ctx: Ctx,
  state: DurableObjectState,
  request: Request,
  url: URL,
  user: UserRow,
): Promise<Response> {
  if (url.pathname === WS_PATH) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse("invalid_request", "This route only accepts a WebSocket upgrade.");
    }
    return acceptSocket(ctx, state, user);
  }

  if (url.pathname === FILES_PREFIX || url.pathname.startsWith(`${FILES_PREFIX}/`)) {
    // Bytes, not JSON, so this route is not in the API table (see `matchFilePath`).
    const file = matchFilePath(url.pathname);
    if (file === null) return errorResponse("not_found", "No such file.");
    const outcome = await serveFile(ctx, user.id, file.id, file.thumb);
    return outcome.ok ? outcome.value : errorResponse(outcome.code, outcome.message);
  }

  const match = matchApiRoute(request.method, url.pathname);
  if (match === null) return errorResponse("not_found", `No API route for ${request.method} ${url.pathname}.`);
  if ("methodMismatch" in match) {
    return errorResponse("invalid_request", `Allowed methods: ${match.methodMismatch.join(", ")}`);
  }

  const admin = isAdmin(ctx, user);
  const params = match.params;
  const name: ApiRouteName = match.name;

  switch (name) {
    case "me":
      return json(me(ctx, user, admin));

    case "markSeen":
      // `touchUser` already ran in `ChatWorkspace.fetch`, which is the whole point of the call.
      return json({ ok: true } satisfies OkResponse);

    case "updateMe": {
      const body = await readJson(request);
      return validated(parseUpdateMe(body), (patch) => {
        const updated = updatePrefs(ctx, user, patch);
        return json({
          user: toUser(updated, ctx.bus.isOnline(updated.id)),
          prefs: toPrefs(updated),
        } satisfies UserResponse);
      });
    }

    case "listChannels":
      return json(listChannels(ctx, user));

    case "createChannel": {
      const body = await readJson(request);
      return validated(parseCreateChannel(body), (create) => respond(createChannel(ctx, user, create)));
    }

    case "updateChannel": {
      const body = await readJson(request);
      return validated(parseUpdateChannel(body), (patch) =>
        respond(updateChannel(ctx, user, admin, params["channelId"]!, patch)),
      );
    }

    case "joinChannel":
      return respond(joinChannel(ctx, user, params["channelId"]!));

    case "leaveChannel":
      return respond(leaveChannel(ctx, user, params["channelId"]!));

    case "archiveChannel":
      return respond(archiveChannel(ctx, user, admin, params["channelId"]!));

    case "readChannel": {
      const body = await readJson(request);
      return validated(parseMarkRead(body), (mark) => respond(markRead(ctx, user, params["channelId"]!, mark)));
    }

    case "updateMembership": {
      const body = await readJson(request);
      return validated(parseUpdateMembership(body), (patch) =>
        respond(updateMembership(ctx, user, params["channelId"]!, patch)),
      );
    }

    case "listMessages":
      return validated(parseListMessagesQuery(url.searchParams), (query) =>
        respond(listMessages(ctx, user.id, params["channelId"]!, query)),
      );

    case "sendMessage": {
      const body = await readJson(request);
      const parsed = parseSendMessage(body);
      if (!parsed.ok) return errorResponse("invalid_request", parsed.message);
      return respond(await sendMessage(ctx, user, params["channelId"]!, parsed.value));
    }

    case "editMessage": {
      const body = await readJson(request);
      return validated(parseEditMessage(body), (edit) =>
        respond(editMessage(ctx, user, params["messageId"]!, edit)),
      );
    }

    case "deleteMessage":
      return respond(await deleteMessage(ctx, user, admin, params["messageId"]!));

    case "addReaction":
    case "removeReaction":
      return validated(parseEmoji(params["emoji"] ?? ""), (emoji) =>
        respond(setReaction(ctx, user, params["messageId"]!, emoji, name === "addReaction")),
      );

    case "listThreads":
      return validated(parseListThreadsQuery(url.searchParams), (query) =>
        respond(listThreads(ctx, user, query)),
      );

    case "followThread":
      return respond(setThreadFollow(ctx, user, params["rootId"]!, true));

    case "unfollowThread":
      return respond(setThreadFollow(ctx, user, params["rootId"]!, false));

    case "search":
      return respond(
        search(
          ctx,
          user,
          url.searchParams.get("q") ?? "",
          url.searchParams.get("cursor") ?? undefined,
          numberParam(url, "limit"),
        ),
      );

    case "createUpload":
      return respond(await createUpload(ctx, user.id, request));

    case "listUsers":
      return json(listUsers(ctx, user, url.searchParams.get("cursor"), numberParam(url, "limit")));

    case "getUser": {
      const row = loadUserRow(ctx, params["userId"]!);
      if (row === null || !visibleInDirectory(ctx, user, row.id)) {
        return errorResponse("not_found", "No such person.");
      }
      return json({ user: toUser(row, ctx.bus.isOnline(row.id)) });
    }

    // Phase 3. Named rather than 404ed so a client can tell "not yet" from "wrong URL".
    case "setAvatar":
    case "subscribePush":
    case "unsubscribePush":
      return errorResponse("not_implemented", `${name} is not implemented yet.`);
  }
}

function me(ctx: Ctx, user: UserRow, admin: boolean): MeResponse {
  return {
    user: toUser(user, true),
    prefs: toPrefs(user),
    admin,
    badges: badgeSummary(ctx, user.id),
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxUploadBytes: maxUploadBytes(ctx.env),
      maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
    },
    protocolVersion: PROTOCOL_VERSION,
  };
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
