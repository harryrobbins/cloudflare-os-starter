// `ingest()`: validate everything, then apply the whole batch in one synchronous transaction.
//
// Rules the plan fixes:
//   * `source` comes from the binding's props. Every id and scope must start with `<source>:`, so one
//     source can neither write nor delete another's documents; `account:` scopes are the gadget
//     source's alone (the agent session's per-account partition, contract `Scope`).
//   * An unchanged push (same body hash, same metadata) is a free no-op.
//   * An edit bumps `revision` and re-chunks; only chunks whose text or vector metadata changed are
//     re-embedded, and a shrunk document's orphaned tail chunks are deleted and tombstoned.
//   * A delete removes the chunks (and so their FTS rows) and writes tombstones in the same
//     transaction, so the document vanishes from both halves at once; the Vectorize delete follows
//     from the purge alarm.

import {
  INGEST_LIMITS,
  type IngestBatch,
  type IngestDocument,
  type IngestResult,
  type PrincipalChange,
  type Scope,
  type ScopeDeclaration,
  type Visibility,
} from "../shared/contract.js";
import { monthBucket } from "../dense.js";
import { approxTokens, documentChunks } from "./chunk.js";
import type { Ctx } from "./context.js";
import { chunkId, inputError, sha256Hex, stripControl, utf8Bytes } from "./util.js";

const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_KIND_CHARS = 64;
const MAX_FACET_CHARS = 256;
const MAX_URL_CHARS = 2048;
const MAX_LABEL_CHARS = INGEST_LIMITS.maxLabelChars;
const MAX_PRINCIPAL_CHARS = 256;
const MAX_SCOPE_BYTES = 512;
const MAX_DROP_SCOPES = 100;
const MAX_SCOPE_DECLARATIONS = 1000;

export type DocumentRow = {
  id: string;
  source: string;
  kind: string;
  title: string;
  url: string | null;
  scope: string;
  vis: Visibility;
  workspace: string | null;
  channel: string | null;
  author_id: string | null;
  author: string | null;
  mime: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  revision: number;
  body_hash: string;
  body: string;
};

interface PreparedDocument {
  row: Omit<DocumentRow, "deleted_at" | "revision">;
  chunks: string[];
  /** Vector ids of `chunks`, by ord. */
  chunkIds: string[];
}

export function validateSource(source: unknown): string {
  if (typeof source !== "string" || !SOURCE_PATTERN.test(source)) {
    throw inputError("source must be a short lowercase name.");
  }
  return source;
}

/** A scope this source may write: its own prefix, or `account:` for the gadget source. */
function checkScope(source: string, scope: unknown, where: string): Scope {
  if (typeof scope !== "string" || scope.length === 0) throw inputError(`${where}: scope is required.`);
  if (utf8Bytes(scope) > MAX_SCOPE_BYTES) throw inputError(`${where}: scope is longer than ${MAX_SCOPE_BYTES} bytes.`);
  const own = `${source}:`;
  if (scope.startsWith(own) && scope.length > own.length) return scope;
  if (source === "gadget" && scope.startsWith("account:") && scope.length > "account:".length) return scope;
  throw inputError(`${where}: scope ${JSON.stringify(scope)} must start with "${own}".`);
}

function checkVis(value: unknown, scope: Scope, where: string): Visibility {
  if (value !== "all" && value !== "scoped") throw inputError(`${where}: vis must be "all" or "scoped".`);
  // An account scope is one agent account's private partition (contract `Scope`).
  if (value === "all" && scope.startsWith("account:")) {
    throw inputError(`${where}: an account: scope cannot be vis "all".`);
  }
  return value;
}

function optionalText(value: unknown, field: string, where: string, max = MAX_FACET_CHARS): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw inputError(`${where}: ${field} must be a string or null.`);
  if (value.length > max) throw inputError(`${where}: ${field} is longer than ${max} characters.`);
  const clean = stripControl(value).trim();
  return clean.length > 0 ? clean : null;
}

function checkTime(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8.64e15) {
    throw inputError(`${where}: ${field} must be epoch milliseconds.`);
  }
  return Math.floor(value);
}

function checkUrl(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_URL_CHARS) {
    throw inputError(`${where}: url must be a string of at most ${MAX_URL_CHARS} characters, or null.`);
  }
  // Origin-relative (but not protocol-relative) or absolute http(s): the SPA renders it as a link, so
  // `javascript:` and friends must never get in.
  // Backslashes and whitespace/control characters are refused outright: browsers read `/\x` and
  // `/<TAB>/x` as protocol-relative.
  if (/[\\\s\u0000-\u001f\u007f]/u.test(value)) {
    throw inputError(`${where}: url must not contain backslashes, whitespace or control characters.`);
  }
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return value;
  } catch {
    // fall through
  }
  throw inputError(`${where}: url must be origin-relative or an http(s) URL.`);
}

function checkDocumentId(source: string, id: unknown, where: string): string {
  const own = `${source}:`;
  if (typeof id !== "string" || !id.startsWith(own) || id.length === own.length) {
    throw inputError(`${where}: id must start with "${own}".`);
  }
  if (utf8Bytes(id) > INGEST_LIMITS.maxIdBytes) {
    throw inputError(`${where}: id is longer than ${INGEST_LIMITS.maxIdBytes} bytes.`);
  }
  return id;
}

async function prepareDocument(source: string, doc: IngestDocument, index: number): Promise<PreparedDocument> {
  const where = `upserts[${index}]`;
  if (doc === null || typeof doc !== "object") throw inputError(`${where}: must be an object.`);
  const id = checkDocumentId(source, doc.id, where);
  if (typeof doc.kind !== "string" || doc.kind.trim().length === 0 || doc.kind.length > MAX_KIND_CHARS) {
    throw inputError(`${where}: kind must be 1-${MAX_KIND_CHARS} characters.`);
  }
  if (typeof doc.title !== "string") throw inputError(`${where}: title must be a string.`);
  if (doc.title.length > INGEST_LIMITS.maxTitleChars) {
    throw inputError(`${where}: title is longer than ${INGEST_LIMITS.maxTitleChars} characters.`);
  }
  if (typeof doc.body !== "string") throw inputError(`${where}: body must be a string.`);
  const scope = checkScope(source, doc.scope, where);
  const vis = checkVis(doc.vis, scope, where);
  const url = checkUrl(doc.url, where);
  const createdAt = checkTime(doc.createdAt, "createdAt", where);
  const updatedAt = checkTime(doc.updatedAt, "updatedAt", where);

  // A longer body is truncated, not refused (INGEST_LIMITS.maxBodyChars).
  const body = stripControl(doc.body.slice(0, INGEST_LIMITS.maxBodyChars));
  const title = stripControl(doc.title).trim();
  const row = {
    id,
    source,
    kind: doc.kind.trim(),
    title,
    url,
    scope,
    vis,
    workspace: optionalText(doc.workspace, "workspace", where),
    channel: optionalText(doc.channel, "channel", where),
    author_id: optionalText(doc.authorId, "authorId", where),
    author: optionalText(doc.author, "author", where),
    mime: optionalText(doc.mime, "mime", where),
    created_at: createdAt,
    updated_at: updatedAt,
    body_hash: await sha256Hex(body),
    body,
  };
  const chunks = documentChunks(title, body);
  const chunkIds = await Promise.all(chunks.map((_, ord) => chunkId(id, ord)));
  return { row, chunks, chunkIds };
}

function prepareDeclaration(source: string, decl: ScopeDeclaration, index: number): ScopeDeclaration {
  const where = `scopes[${index}]`;
  if (decl === null || typeof decl !== "object") throw inputError(`${where}: must be an object.`);
  const scope = checkScope(source, decl.scope, where);
  if (typeof decl.label !== "string") throw inputError(`${where}: label must be a string.`);
  // Truncated, never refused: a refused batch can carry membership changes with it, and a source
  // that drops it would leave a removed member able to search the scope.
  const label = stripControl(decl.label).trim();
  const bounded = label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
  return { scope, label: bounded, vis: checkVis(decl.vis, scope, where) };
}

function principalList(value: unknown, field: string, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw inputError(`${where}: ${field} must be a list.`);
  return value.map((principal, i) => {
    if (typeof principal !== "string" || principal.length === 0 || principal.length > MAX_PRINCIPAL_CHARS) {
      throw inputError(`${where}: ${field}[${i}] must be a non-empty principal id.`);
    }
    return principal;
  });
}

function preparePrincipalChange(source: string, change: PrincipalChange, index: number): PrincipalChange {
  const where = `principals[${index}]`;
  if (change === null || typeof change !== "object") throw inputError(`${where}: must be an object.`);
  const scope = checkScope(source, change.scope, where);
  const replace = principalList(change.replace, "replace", where);
  const add = principalList(change.add, "add", where);
  const remove = principalList(change.remove, "remove", where);
  return {
    scope,
    ...(replace === undefined ? {} : { replace }),
    ...(add === undefined ? {} : { add }),
    ...(remove === undefined ? {} : { remove }),
  };
}

function list<T>(value: T[] | undefined, field: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw inputError(`${field} must be a list.`);
  return value;
}

export async function ingest(ctx: Ctx, sourceRaw: string, batch: IngestBatch): Promise<IngestResult> {
  const source = validateSource(sourceRaw);
  if (batch === null || typeof batch !== "object") throw inputError("the batch must be an object.");

  const upserts = list(batch.upserts, "upserts");
  const deletes = list(batch.deletes, "deletes");
  const declarations = list(batch.scopes, "scopes");
  const principalChanges = list(batch.principals, "principals");
  const dropScopes = list(batch.dropScopes, "dropScopes");

  if (upserts.length + deletes.length > INGEST_LIMITS.maxDocumentsPerBatch) {
    throw inputError(`at most ${INGEST_LIMITS.maxDocumentsPerBatch} upserts and deletes per batch.`);
  }
  if (declarations.length > MAX_SCOPE_DECLARATIONS) {
    throw inputError(`at most ${MAX_SCOPE_DECLARATIONS} scope declarations per batch.`);
  }
  if (dropScopes.length > MAX_DROP_SCOPES) throw inputError(`at most ${MAX_DROP_SCOPES} dropScopes per batch.`);

  // Validate everything before writing anything: a bad batch changes nothing.
  // Hashing is async (Web Crypto), so it happens here, before the synchronous transaction.
  const prepared = await Promise.all(upserts.map((doc, i) => prepareDocument(source, doc, i)));
  const deleteIds = deletes.map((id, i) => checkDocumentId(source, id, `deletes[${i}]`));
  const scopeRows = declarations.map((decl, i) => prepareDeclaration(source, decl, i));
  const changesIn = principalChanges.map((change, i) => preparePrincipalChange(source, change, i));
  const dropped = dropScopes.map((scope, i) => checkScope(source, scope, `dropScopes[${i}]`));
  const principalCount = changesIn.reduce(
    (sum, change) => sum + (change.replace?.length ?? 0) + (change.add?.length ?? 0) + (change.remove?.length ?? 0),
    0,
  );
  // One scope's member list is accepted whole up to its own cap, so a large private channel is
  // never refused (and so never left with its old, wider membership).
  const limit = changesIn.length === 1 ? INGEST_LIMITS.maxPrincipalsPerScope : INGEST_LIMITS.maxPrincipalChanges;
  if (principalCount > limit) {
    throw inputError(`at most ${limit} principal changes per batch.`);
  }

  const now = ctx.now();
  const pending: string[] = [];
  let tombstoned = 0;
  const result: IngestResult = { upserted: 0, unchanged: 0, deleted: 0, queued: 0 };

  ctx.storage.transactionSync(() => {
    for (const decl of scopeRows) pending.push(...declareScope(ctx.sql, source, decl));
    for (const change of changesIn) applyPrincipalChange(ctx.sql, change);
    for (const doc of prepared) {
      const outcome = upsertDocument(ctx.sql, doc, now);
      if (outcome === null) {
        result.unchanged++;
        continue;
      }
      result.upserted++;
      pending.push(...outcome.pending);
      tombstoned += outcome.tombstoned;
    }
    for (const id of deleteIds) {
      const removed = deleteDocument(ctx.sql, id, now);
      if (removed === null) continue;
      result.deleted++;
      tombstoned += removed;
    }
    for (const scope of dropped) {
      const ids = ctx.sql
        .exec<{ id: string }>(`SELECT id FROM documents WHERE scope = ? AND deleted_at IS NULL`, scope)
        .toArray();
      for (const { id } of ids) {
        const removed = deleteDocument(ctx.sql, id, now);
        if (removed === null) continue;
        result.deleted++;
        tombstoned += removed;
      }
      ctx.sql.exec(`DELETE FROM principals WHERE scope = ?`, scope);
      ctx.sql.exec(`DELETE FROM scopes WHERE scope = ?`, scope);
    }
  });

  if (tombstoned > 0) await ctx.armPurge();
  result.queued = await ctx.enqueue([...new Set(pending)]);
  return result;
}

/** Records a scope's label and visibility; a visibility change re-labels its documents' vectors. */
function declareScope(sql: SqlStorage, source: string, decl: ScopeDeclaration): string[] {
  const previous = sql.exec<{ vis: string }>(`SELECT vis FROM scopes WHERE scope = ?`, decl.scope).toArray()[0];
  sql.exec(
    `INSERT INTO scopes (scope, source, label, vis) VALUES (?, ?, ?, ?)
     ON CONFLICT (scope) DO UPDATE SET label = excluded.label, vis = excluded.vis`,
    decl.scope,
    source,
    decl.label,
    decl.vis,
  );
  // Unchanged visibility: nothing to align. A first declaration still aligns documents pushed before it.
  if (previous !== undefined && previous.vis === decl.vis) return [];
  // The documents' `vis` follows the scope, and so does every vector's metadata: a channel made
  // private must stop matching `{vis: "all"}` (the SQL post-filter covers the gap until re-embed).
  const docs = sql
    .exec<{ id: string }>(
      `SELECT id FROM documents WHERE scope = ? AND vis != ? AND deleted_at IS NULL`,
      decl.scope,
      decl.vis,
    )
    .toArray();
  const pending: string[] = [];
  for (const { id } of docs) {
    sql.exec(`UPDATE documents SET vis = ?, revision = revision + 1 WHERE id = ?`, decl.vis, id);
    pending.push(...markDocumentPending(sql, id));
  }
  return pending;
}

function markDocumentPending(sql: SqlStorage, documentId: string): string[] {
  sql.exec(
    `UPDATE chunks SET revision = (SELECT revision FROM documents WHERE id = ?), embed_revision = NULL, embedded_at = NULL
      WHERE document_id = ?`,
    documentId,
    documentId,
  );
  return sql
    .exec<{ id: string }>(`SELECT id FROM chunks WHERE document_id = ?`, documentId)
    .toArray()
    .map((row) => row.id);
}

function applyPrincipalChange(sql: SqlStorage, change: PrincipalChange): void {
  if (change.replace !== undefined) {
    sql.exec(`DELETE FROM principals WHERE scope = ?`, change.scope);
    for (const principal of new Set(change.replace)) {
      sql.exec(`INSERT INTO principals (scope, principal) VALUES (?, ?) ON CONFLICT DO NOTHING`, change.scope, principal);
    }
    return;
  }
  for (const principal of change.add ?? []) {
    sql.exec(`INSERT INTO principals (scope, principal) VALUES (?, ?) ON CONFLICT DO NOTHING`, change.scope, principal);
  }
  for (const principal of change.remove ?? []) {
    sql.exec(`DELETE FROM principals WHERE scope = ? AND principal = ?`, change.scope, principal);
  }
}

const METADATA_FIELDS = [
  "kind",
  "title",
  "url",
  "scope",
  "vis",
  "workspace",
  "channel",
  "author_id",
  "author",
  "mime",
  "created_at",
  "updated_at",
  "body_hash",
] as const;

/** Null when the push was a no-op. */
function upsertDocument(
  sql: SqlStorage,
  doc: PreparedDocument,
  now: number,
): { pending: string[]; tombstoned: number } | null {
  const { row } = doc;
  const existing = sql.exec<DocumentRow>(`SELECT * FROM documents WHERE id = ?`, row.id).toArray()[0];
  const live = existing !== undefined && existing.deleted_at === null;
  if (live && METADATA_FIELDS.every((field) => existing[field] === row[field])) return null;

  const revision = (existing?.revision ?? 0) + 1;
  sql.exec(
    `INSERT INTO documents (id, source, kind, title, url, scope, vis, workspace, channel, author_id, author, mime,
                            created_at, updated_at, deleted_at, revision, body_hash, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, url = excluded.url, scope = excluded.scope,
       vis = excluded.vis, workspace = excluded.workspace, channel = excluded.channel,
       author_id = excluded.author_id, author = excluded.author, mime = excluded.mime,
       created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = NULL,
       revision = excluded.revision, body_hash = excluded.body_hash, body = excluded.body`,
    row.id,
    row.source,
    row.kind,
    row.title,
    row.url,
    row.scope,
    row.vis,
    row.workspace,
    row.channel,
    row.author_id,
    row.author,
    row.mime,
    row.created_at,
    row.updated_at,
    revision,
    row.body_hash,
    row.body,
  );

  // Anything in the vector (text, the title every chunk's embedding carries, or the six metadata
  // fields) changing means that vector must be rewritten.
  const vectorChanged =
    !live ||
    existing.title !== row.title ||
    existing.scope !== row.scope ||
    existing.vis !== row.vis ||
    existing.kind !== row.kind ||
    existing.author_id !== row.author_id ||
    monthBucket(existing.updated_at) !== monthBucket(row.updated_at);

  const old = new Map(
    sql
      .exec<{ id: string; ord: number; text: string }>(`SELECT id, ord, text FROM chunks WHERE document_id = ?`, row.id)
      .toArray()
      .map((chunk) => [chunk.ord, chunk]),
  );
  const pending: string[] = [];
  doc.chunks.forEach((text, ord) => {
    const id = doc.chunkIds[ord]!;
    const before = old.get(ord);
    if (before === undefined) {
      sql.exec(
        `INSERT INTO chunks (id, document_id, ord, text, tokens, revision, embed_revision, embedded_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        id,
        row.id,
        ord,
        text,
        approxTokens(text),
        revision,
      );
      // A resurrected document reuses its chunk ids; its tombstones must not delete the new vectors.
      sql.exec(`DELETE FROM tombstones WHERE chunk_id = ?`, id);
      pending.push(id);
    } else if (vectorChanged || before.text !== text) {
      sql.exec(
        `UPDATE chunks SET text = ?, tokens = ?, revision = ?, embed_revision = NULL, embedded_at = NULL WHERE id = ?`,
        text,
        approxTokens(text),
        revision,
        id,
      );
      pending.push(id);
    }
  });

  let tombstoned = 0;
  for (const [ord, chunk] of old) {
    if (ord < doc.chunks.length) continue;
    tombstoneChunk(sql, chunk.id, now);
    tombstoned++;
  }
  return { pending, tombstoned };
}

/** Deletes a document's chunks and tombstones them. Null when there was nothing live to delete. */
function deleteDocument(sql: SqlStorage, id: string, now: number): number | null {
  const existing = sql
    .exec<{ deleted_at: number | null }>(`SELECT deleted_at FROM documents WHERE id = ?`, id)
    .toArray()[0];
  if (existing === undefined || existing.deleted_at !== null) return null;
  sql.exec(`UPDATE documents SET deleted_at = ?, body = '', revision = revision + 1 WHERE id = ?`, now, id);
  const chunks = sql.exec<{ id: string }>(`SELECT id FROM chunks WHERE document_id = ?`, id).toArray();
  for (const chunk of chunks) tombstoneChunk(sql, chunk.id, now);
  return chunks.length;
}

function tombstoneChunk(sql: SqlStorage, id: string, now: number): void {
  // Deleting the row fires the FTS delete trigger: the text is unsearchable when this commits.
  sql.exec(`DELETE FROM chunks WHERE id = ?`, id);
  sql.exec(
    `INSERT INTO tombstones (chunk_id, deleted_at, purged_at) VALUES (?, ?, NULL)
     ON CONFLICT (chunk_id) DO UPDATE SET deleted_at = excluded.deleted_at, purged_at = NULL`,
    id,
    now,
  );
}
