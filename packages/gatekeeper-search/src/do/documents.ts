// Reads that are not a search: open one document, the per-source summary, and the admin stats.

import {
  EMBED_REVISION,
  KNOWN_SOURCES,
  MAX_OPEN_CHARS,
  SOURCE_LABELS,
  type DocumentText,
  type IndexStats,
  type SearchCaller,
  type SourceSummary,
} from "../shared/contract.js";
import { resolveAcl } from "./acl.js";
import { inputError } from "./util.js";

export function openDocument(sql: SqlStorage, caller: SearchCaller, documentId: string): DocumentText | null {
  if (typeof documentId !== "string" || documentId.length === 0 || documentId.length > 2048) {
    throw inputError("documentId must be a non-empty string.");
  }
  const acl = resolveAcl(sql, caller);
  const row = sql
    .exec<{
      id: string;
      source: string;
      kind: string;
      title: string;
      url: string | null;
      scope: string;
      scope_label: string | null;
      author: string | null;
      updated_at: number;
      body: string;
    }>(
      `SELECT d.id, d.source, d.kind, d.title, d.url, d.scope, s.label AS scope_label, d.author, d.updated_at, d.body
         FROM documents d LEFT JOIN scopes s ON s.scope = d.scope
        WHERE d.id = ? AND d.deleted_at IS NULL AND ${acl.clause}`,
      documentId,
      ...acl.params,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const truncated = row.body.length > MAX_OPEN_CHARS;
  return {
    documentId: row.id,
    source: row.source,
    kind: row.kind,
    title: row.title,
    url: row.url,
    scope: row.scope,
    scopeLabel: row.scope_label,
    author: row.author,
    updatedAt: row.updated_at,
    text: truncated ? row.body.slice(0, MAX_OPEN_CHARS) : row.body,
    truncated,
  };
}

/** One row per known source plus any other source this caller can see, with visible counts. */
export function sourceSummaries(sql: SqlStorage, caller: SearchCaller): SourceSummary[] {
  const acl = resolveAcl(sql, caller);
  const rows = sql
    .exec<{ source: string; documents: number; last: number | null }>(
      `SELECT d.source AS source, COUNT(*) AS documents, MAX(d.updated_at) AS last
         FROM documents d
        WHERE d.deleted_at IS NULL AND ${acl.clause}
        GROUP BY d.source`,
      ...acl.params,
    )
    .toArray();
  const bySource = new Map(rows.map((row) => [row.source, row]));
  const names = [...new Set<string>([...KNOWN_SOURCES, ...bySource.keys()])];
  return names.map((source) => {
    const row = bySource.get(source);
    return {
      source,
      label: SOURCE_LABELS[source] ?? source,
      documents: row?.documents ?? 0,
      lastUpdatedAt: row?.last ?? null,
    };
  });
}

export function indexStats(sql: SqlStorage): IndexStats {
  const count = (query: string, ...params: (string | number)[]): number =>
    sql.exec<{ n: number }>(query, ...params).one().n;
  return {
    documents: count(`SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL`),
    deletedDocuments: count(`SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL`),
    chunks: count(`SELECT COUNT(*) AS n FROM chunks`),
    pendingEmbeds: count(
      `SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NULL OR embed_revision IS NOT ?`,
      EMBED_REVISION,
    ),
    tombstones: count(`SELECT COUNT(*) AS n FROM tombstones`),
    scopes: count(`SELECT COUNT(*) AS n FROM scopes`),
    principals: count(`SELECT COUNT(*) AS n FROM principals`),
    bySource: sql
      .exec<{ source: string; documents: number }>(
        `SELECT source, COUNT(*) AS documents FROM documents WHERE deleted_at IS NULL GROUP BY source ORDER BY source`,
      )
      .toArray(),
  };
}
