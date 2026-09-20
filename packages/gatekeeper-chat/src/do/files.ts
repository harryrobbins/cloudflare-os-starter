// Uploads, attachment commit, authenticated downloads and the abandoned-object sweep.
//
// Three rules from chat.md's security checklist shape all of it:
//
//   1. The byte cap is enforced while reading, not after. `request.formData()` on its own would
//      buffer whatever the client sent before anybody could object, so the body is piped through a
//      counting transform that errors the stream the moment the cap is passed; the parse then fails
//      and nothing more is read.
//   2. The mime type is sniffed from the leading bytes. A client's `Content-Type` is a hint, and an
//      `image/*` type is what decides whether a file renders inline, so it is never taken on trust.
//      Anything that is not a recognised image is stored and served as an attachment.
//   3. An object exists before the message that references it, so it is written under `pending/` and
//      promoted to `files/<year>/` when the message commits. Whatever is never promoted is deleted by
//      the sweep alarm an hour later.

import { maxUploadBytes } from "../env.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  PENDING_UPLOAD_TTL_MS,
  type Attachment,
  type AttachmentId,
  type ChannelId,
  type UploadResponse,
  type UserId,
} from "../shared/protocol.js";
import { isId } from "../shared/validate.js";
import { allow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { requireRead } from "./access.js";
import { newAttachmentId } from "./ids.js";
import { consume } from "./limits.js";
import { hashId, logEvent } from "./logs.js";
import { toAttachment, type AttachmentRow } from "./rows.js";

const MAX_FILE_NAME_LENGTH = 255;
/** Client-supplied pixel dimensions are accepted but clamped: decoding an image here is not worth it. */
const MAX_IMAGE_DIMENSION = 20_000;
const SNIFF_BYTES = 16;
const OCTET_STREAM = "application/octet-stream";

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function createUpload(
  ctx: Ctx,
  uploaderId: UserId,
  request: Request,
): Promise<Outcome<UploadResponse>> {
  const limited = consume(ctx, uploaderId, "uploads");
  if (!limited.ok) return limited;

  const limit = maxUploadBytes(ctx.env);
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return tooLarge(limit);
  }
  if (request.body === null) return refuse("invalid_request", "The upload has no body.");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return refuse("invalid_request", "Uploads are multipart/form-data.");
  }

  const parsed = await readCappedForm(request.body, contentType, limit);
  if (!parsed.ok) return parsed;
  const form = parsed.value;

  const channelId = form.get("channelId");
  if (typeof channelId !== "string" || !isId(channelId)) {
    return refuse("invalid_request", "channelId must be an identifier.");
  }
  const access = requireRead(ctx, channelId, uploaderId);
  if (!access.ok) return access;
  if (access.value.channel.archived_at !== null) {
    return refuse("forbidden", "This channel is archived.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return refuse("invalid_request", "Attach the bytes as a `file` part.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) return refuse("invalid_request", "The file is empty.");
  if (bytes.byteLength > limit) return tooLarge(limit);

  const mime = sniffMime(bytes);
  const name = safeFileName(typeof form.get("name") === "string" ? String(form.get("name")) : file.name);
  const { width, height } = mime.startsWith("image/")
    ? clampDimensions(form.get("width"), form.get("height"))
    : { width: null, height: null };

  const id = newAttachmentId(ctx.now());
  const key = pendingKey(id);
  const createdAt = ctx.now();
  try {
    await ctx.env.FILES.put(key, bytes, {
      httpMetadata: { contentType: mime },
      customMetadata: { uploaderId, channelId, createdAt: String(createdAt) },
    });
  } catch {
    logEvent("chat.r2.error", { op: "put", user: hashId(uploaderId) });
    return refuse("internal", "The file could not be stored.");
  }

  ctx.sql.exec(
    `INSERT INTO attachments (id, message_id, channel_id, uploader_id, r2_key, name, mime, bytes,
                              width, height, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    channelId,
    uploaderId,
    key,
    name,
    mime,
    bytes.byteLength,
    width,
    height,
    createdAt,
  );
  await ctx.armSweep();

  logEvent("chat.upload", {
    channel: hashId(channelId),
    user: hashId(uploaderId),
    bytes: bytes.byteLength,
    image: mime.startsWith("image/"),
  });
  return allow({ attachment: toAttachment(loadAttachmentRow(ctx, id)!) });
}

function tooLarge(limit: number): Outcome<never> {
  return refuse("payload_too_large", `The upload exceeds the ${limit} byte limit.`);
}

/**
 * Parses multipart form data, stopping the moment `limit` bytes have been read.
 *
 * The transform errors the stream rather than truncating it, so the parse fails loudly instead of
 * committing half a file, and the source stream stops being pulled.
 */
async function readCappedForm(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  limit: number,
): Promise<Outcome<FormData>> {
  let total = 0;
  let exceeded = false;
  const capped = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          exceeded = true;
          controller.error(new Error("upload too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    return allow(await new Response(capped, { headers: { "content-type": contentType } }).formData());
  } catch {
    if (exceeded) return tooLarge(limit);
    return refuse("invalid_request", "The multipart body could not be parsed.");
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface PromotedAttachment {
  readonly row: AttachmentRow;
  readonly key: string;
}

/**
 * Checks that every id names a pending upload this author made for this channel.
 *
 * "Pending" is the authorization: an attachment already attached to a message cannot be re-used to
 * smuggle a file from one channel into another.
 */
export function preparePending(
  ctx: Ctx,
  uploaderId: UserId,
  channelId: ChannelId,
  ids: readonly AttachmentId[],
): Outcome<readonly AttachmentRow[]> {
  if (ids.length === 0) return allow([]);
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return refuse("invalid_request", `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
  }
  const rows = ctx.sql
    .exec<AttachmentRow>(
      `SELECT * FROM attachments WHERE id IN (${placeholders(ids.length)}) AND message_id IS NULL`,
      ...ids,
    )
    .toArray();
  if (rows.length !== ids.length) {
    return refuse("not_found", "One of the attachments is unknown or already attached.");
  }
  for (const row of rows) {
    if (row.uploader_id !== uploaderId || row.channel_id !== channelId) {
      logEvent("chat.deny", { reason: "attachment_owner", user: hashId(uploaderId) });
      return refuse("forbidden", "That attachment belongs to another upload.");
    }
  }
  // Same order as the request, so the message renders its attachments as the sender arranged them.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return allow(ids.map((id) => byId.get(id)!));
}

/** Final key: `files/<year>/<id>`. Year-partitioned so a bucket listing stays browsable. */
export function finalKey(id: AttachmentId, now: number): string {
  return `files/${new Date(now).getUTCFullYear()}/${id}`;
}

export function pendingKey(id: AttachmentId): string {
  return `pending/${id}`;
}

/**
 * Copies each pending object to its final key, before the message transaction runs.
 *
 * R2 cannot take part in a SQLite transaction, so the order is: copy, commit, then delete the pending
 * copies ({@link discardPending}). If the commit fails the caller deletes the new objects
 * ({@link rollbackPromoted}) and the pending rows survive for the sweep.
 */
export async function promotePending(
  ctx: Ctx,
  rows: readonly AttachmentRow[],
): Promise<Outcome<readonly PromotedAttachment[]>> {
  const promoted: PromotedAttachment[] = [];
  for (const row of rows) {
    const key = finalKey(row.id, row.created_at);
    try {
      const object = await ctx.env.FILES.get(row.r2_key);
      if (object === null) {
        await rollbackPromoted(ctx, promoted);
        return refuse("not_found", "The uploaded file has expired.");
      }
      await ctx.env.FILES.put(key, object.body, {
        httpMetadata: { contentType: row.mime },
        customMetadata: { uploaderId: row.uploader_id, channelId: row.channel_id },
      });
      promoted.push({ row, key });
    } catch {
      logEvent("chat.r2.error", { op: "promote", attachment: hashId(row.id) });
      await rollbackPromoted(ctx, promoted);
      return refuse("internal", "The file could not be attached.");
    }
  }
  return allow(promoted);
}

/** Best effort: an object left behind here is unreferenced, not visible. */
export async function rollbackPromoted(ctx: Ctx, promoted: readonly PromotedAttachment[]): Promise<void> {
  for (const entry of promoted) {
    try {
      await ctx.env.FILES.delete(entry.key);
    } catch {
      logEvent("chat.r2.error", { op: "rollback", attachment: hashId(entry.row.id) });
    }
  }
}

/** Deletes the `pending/` copies once the message that references the final keys has committed. */
export async function discardPending(ctx: Ctx, promoted: readonly PromotedAttachment[]): Promise<void> {
  for (const entry of promoted) {
    try {
      await ctx.env.FILES.delete(entry.row.r2_key);
    } catch {
      logEvent("chat.r2.error", { op: "discard", attachment: hashId(entry.row.id) });
    }
  }
}

export function loadAttachmentRow(ctx: Ctx, id: AttachmentId): AttachmentRow | null {
  return ctx.sql.exec<AttachmentRow>(`SELECT * FROM attachments WHERE id = ?`, id).toArray()[0] ?? null;
}

export function attachmentsFor(ctx: Ctx, messageIds: readonly string[]): Map<string, Attachment[]> {
  const byMessage = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return byMessage;
  for (const row of ctx.sql
    .exec<AttachmentRow>(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders(messageIds.length)})
       ORDER BY created_at, id`,
      ...messageIds,
    )
    .toArray()) {
    const list = byMessage.get(row.message_id!) ?? [];
    list.push(toAttachment(row));
    byMessage.set(row.message_id!, list);
  }
  return byMessage;
}

export function attachmentRowsForMessage(ctx: Ctx, messageId: string): readonly AttachmentRow[] {
  return ctx.sql.exec<AttachmentRow>(`SELECT * FROM attachments WHERE message_id = ?`, messageId).toArray();
}

/**
 * Deletes the R2 objects behind some attachments.
 *
 * Separate from the row deletion because that happens inside the message transaction, and R2 cannot
 * take part in one. A failure here leaves bytes nobody can reach, which is the harmless direction.
 */
export async function deleteObjects(ctx: Ctx, rows: readonly AttachmentRow[]): Promise<void> {
  for (const row of rows) {
    for (const key of [row.r2_key, row.thumb_key]) {
      if (key === null) continue;
      try {
        await ctx.env.FILES.delete(key);
      } catch {
        logEvent("chat.r2.error", { op: "delete", attachment: hashId(row.id) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * `GET files/:id` and `GET files/:id/thumb`.
 *
 * Membership is rechecked here on every request, because a shared or edge cache must never be able to
 * serve a file after access to its channel was revoked -- hence `private, no-store` as well.
 *
 * `thumb` currently serves the same object. TODO: generate a real thumbnail on commit; the plan's
 * "generate trusted thumbnails server-side" needs an image decoder the Worker does not have yet, and
 * a client-supplied thumbnail would be untrusted bytes served under an image content type.
 */
export async function serveFile(
  ctx: Ctx,
  userId: UserId,
  attachmentId: AttachmentId,
  thumb: boolean,
): Promise<Outcome<Response>> {
  const row = loadAttachmentRow(ctx, attachmentId);
  if (row === null || row.message_id === null) return refuse("not_found", "No such file.");
  const access = requireRead(ctx, row.channel_id, userId);
  if (!access.ok) return access;

  const key = thumb ? (row.thumb_key ?? row.r2_key) : row.r2_key;
  let object: R2ObjectBody | null;
  try {
    object = await ctx.env.FILES.get(key);
  } catch {
    logEvent("chat.r2.error", { op: "get", attachment: hashId(attachmentId) });
    return refuse("internal", "The file could not be read.");
  }
  if (object === null) return refuse("not_found", "No such file.");

  // Only a sniffed image is safe to render inline; everything else downloads.
  const inline = isVerifiedImage(row.mime);
  return allow(
    new Response(object.body, {
      headers: {
        "content-type": row.mime,
        "content-length": String(row.bytes),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiFileName(row.name)}"`,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Deletes pending objects older than the TTL. Returns how many pending rows are still waiting. */
export async function sweepPending(ctx: Ctx): Promise<number> {
  const cutoff = ctx.now() - PENDING_UPLOAD_TTL_MS;
  const stale = ctx.sql
    .exec<{ id: string; r2_key: string }>(
      `SELECT id, r2_key FROM attachments WHERE message_id IS NULL AND created_at < ?`,
      cutoff,
    )
    .toArray();
  for (const row of stale) {
    try {
      await ctx.env.FILES.delete(row.r2_key);
    } catch {
      logEvent("chat.r2.error", { op: "sweep", attachment: hashId(row.id) });
    }
    ctx.sql.exec(`DELETE FROM attachments WHERE id = ?`, row.id);
  }
  if (stale.length > 0) logEvent("chat.upload.swept", { count: stale.length });
  return (
    ctx.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE message_id IS NULL`)
      .toArray()[0]?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// Sniffing and names
// ---------------------------------------------------------------------------

const MAGIC: readonly { readonly mime: string; readonly bytes: readonly number[]; readonly at?: number }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * The mime type, from the bytes.
 *
 * Only png, jpeg, gif and webp are recognised, and only those are served inline. Everything else is
 * `application/octet-stream` with `Content-Disposition: attachment`, which is what makes an svg or an
 * html file harmless: it downloads instead of executing on this origin.
 */
export function sniffMime(bytes: Uint8Array): string {
  const head = bytes.subarray(0, SNIFF_BYTES);
  for (const candidate of MAGIC) {
    const at = candidate.at ?? 0;
    if (candidate.bytes.every((byte, index) => head[at + index] === byte)) return candidate.mime;
  }
  // RIFF....WEBP: a container, so the tag is at offset 8, not the start.
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (
    riff.every((byte, index) => head[index] === byte) &&
    webp.every((byte, index) => head[8 + index] === byte)
  ) {
    return "image/webp";
  }
  return OCTET_STREAM;
}

export function isVerifiedImage(mime: string): boolean {
  return mime.startsWith("image/");
}

/** `FormData.get` returns a string or a File; the workers types do not name that union. */
type FormValue = string | File | null;

function clampDimensions(
  width: FormValue,
  height: FormValue,
): { width: number | null; height: number | null } {
  return { width: clampDimension(width), height: clampDimension(height) };
}

function clampDimension(value: FormValue): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_IMAGE_DIMENSION);
}

/** Strips directories and control characters; the name is only ever shown, never resolved. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[/\\]/u).at(-1) ?? "";
  const cleaned = base.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return (cleaned.length === 0 ? "file" : cleaned).slice(0, MAX_FILE_NAME_LENGTH);
}

/** A `filename=` parameter cannot carry quotes, backslashes or non-ASCII without quoting rules. */
function asciiFileName(name: string): string {
  const ascii = name.replaceAll(/[^\u0020-\u007E]/gu, "_").replaceAll(/["\\]/gu, "_");
  return ascii.length === 0 ? "file" : ascii;
}
