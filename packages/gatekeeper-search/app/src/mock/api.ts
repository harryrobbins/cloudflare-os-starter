// An in-memory `SearchApi` over the fixtures, for `VITE_SEARCH_MOCK=1` builds and tests.
//
// It imitates the server closely enough to exercise every UI state: qualifiers (parsed the same way
// the omni grammar does, dates included), `<mark>` snippets built from escaped text, facets, cursor
// paging, dense-only hits ("found by meaning"), and the failure modes. Pick a state with `?mock=`:
//
//   ?mock=off           dense retrieval switched off
//   ?mock=unavailable   dense retrieval failed, lexical only
//   ?mock=member        not an admin (no stats panel)
//   ?mock=401 | 403 | 429 | 500   every search fails with that status
//   ?mock=nosources     an empty index
//   ?mock=slow          1.2 s latency, to see the loading state
//
// Several can be combined: `?mock=unavailable,member`.

import {
  SOURCE_LABELS,
  type DenseStatus,
  type DocumentText,
  type ErrorCode,
  type Facet,
  type FacetField,
  type IndexStats,
  type Me,
  type OmniHit,
  type OmniQuery,
  type OmniSearchResult,
  type SearchRequest,
  type SourceSummary,
} from "../contract.js";
import { ApiError, type SearchApi } from "../api/client.js";
import { splitQualifier, tokenize } from "../lib/query.js";
import { FIXTURE_DOCUMENTS, FIXTURE_SCOPES, type FixtureDocument } from "./fixtures.js";

const DAY_MS = 86_400_000;

export interface MockOptions {
  dense?: DenseStatus;
  admin?: boolean;
  /** Every search fails with this status. */
  failStatus?: 401 | 403 | 429 | 500;
  empty?: boolean;
  latencyMs?: number;
  /** Characters a document preview is capped at; small, so the runbook shows the truncated notice. */
  openCap?: number;
  documents?: FixtureDocument[];
}

export function mockOptionsFromLocation(search: string): MockOptions {
  const raw = new URLSearchParams(search).get("mock") ?? "";
  const flags = new Set(raw.split(",").map((flag) => flag.trim().toLowerCase()));
  const options: MockOptions = { latencyMs: 180 };
  if (flags.has("off")) options.dense = "off";
  if (flags.has("unavailable")) options.dense = "unavailable";
  if (flags.has("member")) options.admin = false;
  if (flags.has("nosources")) options.empty = true;
  if (flags.has("slow")) options.latencyMs = 1200;
  for (const status of [401, 403, 429, 500] as const) {
    if (flags.has(String(status))) options.failStatus = status;
  }
  return options;
}

const STATUS_CODE: Record<number, ErrorCode> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
  500: "internal",
};

const STATUS_MESSAGE: Record<number, string> = {
  401: "Access session missing or expired.",
  403: "Admins only.",
  429: "Slow down: too many searches.",
  500: "The search index is unavailable.",
};

function fail(status: number, message?: string): never {
  throw new ApiError(STATUS_CODE[status] ?? "internal", message ?? STATUS_MESSAGE[status] ?? "Failed.", status);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;",
  );
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(at) ? null : at;
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/su, "$1");
}

/** The mock's copy of the omni grammar. */
export function parseMockQuery(raw: string): OmniQuery {
  const text: string[] = [];
  const query: OmniQuery = { text: "" };
  const add = (key: "in" | "from" | "source" | "kind" | "workspace", value: string): void => {
    const list = query[key] ?? [];
    if (!list.includes(value)) list.push(value);
    query[key] = list;
  };
  for (const token of tokenize(raw)) {
    const split = splitQualifier(token);
    if (split === null) {
      text.push(unquote(token));
      continue;
    }
    const value = unquote(split.value);
    switch (split.key) {
      case "in": {
        const wanted = value.toLowerCase();
        const row = FIXTURE_SCOPES.find(
          (scope) =>
            scope.scope.toLowerCase() === wanted ||
            scope.label.toLowerCase() === wanted ||
            scope.label.toLowerCase() === `#${wanted}`,
        );
        if (row === undefined) fail(400, `No scope called ${value}.`);
        add("in", row.scope);
        break;
      }
      case "from":
        add("from", value.replace(/^@/u, ""));
        break;
      case "source":
      case "kind":
      case "workspace":
        add(split.key, value.toLowerCase());
        break;
      case "before":
      case "after":
      case "on": {
        const day = parseDay(value);
        if (day === null) fail(400, `${split.key}: needs a date like 2026-09-01.`);
        if (split.key === "before") query.before = day - 1;
        else if (split.key === "after") query.after = day + DAY_MS;
        else {
          query.after = day;
          query.before = day + DAY_MS - 1;
        }
        break;
      }
      default:
        text.push(token);
    }
  }
  query.text = text.join(" ");
  return query;
}

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.replace(/[^\p{L}\p{N}*]/gu, ""))
    .filter((term) => term.replace(/\*/gu, "").length > 0);
}

function termPattern(term: string): RegExp {
  const prefix = term.endsWith("*");
  const stem = term.replace(/\*/gu, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(prefix ? `\\b${stem}\\w*` : `\\b${stem}\\b`, "giu");
}

function lexicalScore(doc: FixtureDocument, wanted: string[]): number {
  if (wanted.length === 0) return 0;
  const haystack = `${doc.title}\n${doc.body}`;
  let score = 0;
  for (const term of wanted) {
    const count = haystack.match(termPattern(term))?.length ?? 0;
    if (count === 0) return 0;
    score += count;
  }
  return score;
}

function denseScore(doc: FixtureDocument, wanted: string[]): number {
  let score = 0;
  for (const term of wanted) {
    const stem = term.replace(/\*/gu, "");
    if (doc.topics.some((topic) => topic.startsWith(stem) || stem.startsWith(topic))) score += 1;
  }
  return score / Math.max(wanted.length, 1);
}

function snippet(doc: FixtureDocument, wanted: string[], lexical: boolean): string {
  const body = doc.body.replace(/\s+/gu, " ");
  if (!lexical || wanted.length === 0) {
    return escapeHtml(body.length > 180 ? `${body.slice(0, 180)}…` : body);
  }
  const patterns = wanted.map(termPattern);
  let first = body.length;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(body);
    if (match !== null) first = Math.min(first, match.index);
  }
  if (first === body.length) first = 0;
  const start = Math.max(0, first - 60);
  const end = Math.min(body.length, start + 200);
  const window = body.slice(start, end);
  // Mark on the raw window, escape each piece: the snippet is escaped text plus <mark> only.
  const combined = new RegExp(patterns.map((pattern) => pattern.source).join("|"), "giu");
  let html = "";
  let at = 0;
  for (const match of window.matchAll(combined)) {
    html += escapeHtml(window.slice(at, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
    at = match.index + match[0].length;
  }
  html += escapeHtml(window.slice(at));
  return `${start > 0 ? "…" : ""}${html}${end < body.length ? "…" : ""}`;
}

function scopeLabel(scope: string): string | null {
  return FIXTURE_SCOPES.find((row) => row.scope === scope)?.label ?? null;
}

function month(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

function facets(hits: OmniHit[]): Facet[] {
  const fields: [FacetField, (hit: OmniHit) => [string, string] | null][] = [
    ["source", (hit) => [hit.source, SOURCE_LABELS[hit.source] ?? hit.source]],
    ["kind", (hit) => [hit.kind, hit.kind]],
    ["scope", (hit) => [hit.scope, hit.scopeLabel ?? hit.scope]],
    ["author", (hit) => (hit.author === null ? null : [hit.author, hit.author])],
    ["workspace", (hit) => (hit.workspace === null ? null : [hit.workspace, hit.workspace])],
    ["month", (hit) => [month(hit.updatedAt), month(hit.updatedAt)]],
  ];
  return fields
    .map(([field, pick]) => {
      const counts = new Map<string, { label: string; count: number }>();
      for (const hit of hits) {
        const picked = pick(hit);
        if (picked === null) continue;
        const entry = counts.get(picked[0]) ?? { label: picked[1], count: 0 };
        entry.count += 1;
        counts.set(picked[0], entry);
      }
      const values = [...counts.entries()]
        .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }))
        .sort((a, b) => (field === "month" ? b.value.localeCompare(a.value) : b.count - a.count || a.label.localeCompare(b.label)));
      return { field, values };
    })
    .filter((facet) => facet.values.length > 0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export function createMockApi(options: MockOptions = {}): SearchApi {
  const documents = options.empty === true ? [] : (options.documents ?? FIXTURE_DOCUMENTS);
  const dense: DenseStatus = options.dense ?? "ok";
  const latency = options.latencyMs ?? 0;
  const cap = options.openCap ?? 4000;
  let pendingEmbeds = options.empty === true ? 0 : 37;

  const me: Me = { id: "harry", email: "harry@example.com", isAdmin: options.admin ?? true };

  return {
    async me(signal) {
      await sleep(latency / 3, signal);
      return me;
    },

    async search(request: SearchRequest, signal) {
      const started = Date.now();
      await sleep(latency, signal);
      if (options.failStatus !== undefined) fail(options.failStatus);
      const query = parseMockQuery(request.q);
      const wanted = terms(query.text);

      const eligible = documents.filter((doc) => {
        const source = doc.id.split(":")[0]!;
        if (query.in !== undefined && !query.in.includes(doc.scope)) return false;
        if (query.source !== undefined && !query.source.includes(source)) return false;
        if (query.kind !== undefined && !query.kind.includes(doc.kind)) return false;
        if (query.workspace !== undefined && !query.workspace.includes(doc.workspace ?? "")) return false;
        if (query.from !== undefined) {
          const author = (doc.author ?? "").toLowerCase();
          const ok = query.from.some(
            (name) => (name === "me" ? doc.authorId === me.id : author === name.toLowerCase() || author.split(" ")[0] === name.toLowerCase()),
          );
          if (!ok) return false;
        }
        if (query.after !== undefined && doc.updatedAt < query.after) return false;
        if (query.before !== undefined && doc.updatedAt > query.before) return false;
        return true;
      });

      const lexical = eligible
        .map((doc) => ({ doc, score: wanted.length === 0 ? 1 : lexicalScore(doc, wanted) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt);
      const semantic =
        dense === "ok" && wanted.length > 0
          ? eligible
              .map((doc) => ({ doc, score: denseScore(doc, wanted) }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt)
          : [];

      const fused = new Map<string, { doc: FixtureDocument; lexicalRank: number | null; denseRank: number | null; score: number }>();
      lexical.forEach((entry, index) => {
        fused.set(entry.doc.id, { doc: entry.doc, lexicalRank: index + 1, denseRank: null, score: 1 / (60 + index + 1) });
      });
      semantic.forEach((entry, index) => {
        const existing = fused.get(entry.doc.id);
        const add = 1 / (60 + index + 1);
        if (existing === undefined) {
          fused.set(entry.doc.id, { doc: entry.doc, lexicalRank: null, denseRank: index + 1, score: add });
        } else {
          existing.denseRank = index + 1;
          existing.score += add;
        }
      });

      const all: OmniHit[] = [...fused.values()]
        .sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt)
        .map(({ doc, lexicalRank, denseRank, score }) => ({
          documentId: doc.id,
          source: doc.id.split(":")[0]!,
          kind: doc.kind,
          title: doc.title,
          url: doc.url,
          snippet: snippet(doc, wanted, lexicalRank !== null),
          score,
          lexicalRank,
          denseRank,
          scope: doc.scope,
          scopeLabel: scopeLabel(doc.scope),
          vis: doc.vis,
          workspace: doc.workspace ?? null,
          channel: doc.channel ?? null,
          author: doc.author ?? null,
          mime: doc.mime ?? null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        }));

      const limit = Math.min(request.limit ?? 20, 50);
      const offset = request.cursor === undefined ? 0 : Number(request.cursor) || 0;
      const page = all.slice(offset, offset + limit);
      return {
        query,
        hits: page,
        facets: request.facets === false ? [] : facets(all),
        cursor: offset + limit < all.length ? String(offset + limit) : null,
        dense,
        tookMs: Math.max(1, Date.now() - started - latency) + 12,
      } satisfies OmniSearchResult;
    },

    async sources(signal) {
      await sleep(latency / 2, signal);
      const bySource = new Map<string, SourceSummary>();
      for (const doc of documents) {
        const source = doc.id.split(":")[0]!;
        const entry = bySource.get(source) ?? {
          source,
          label: SOURCE_LABELS[source] ?? source,
          documents: 0,
          lastUpdatedAt: null,
        };
        entry.documents += 1;
        entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt ?? 0, doc.updatedAt);
        bySource.set(source, entry);
      }
      return [...bySource.values()].sort((a, b) => b.documents - a.documents);
    },

    async document(id, signal) {
      await sleep(latency / 2, signal);
      const doc = documents.find((candidate) => candidate.id === id);
      if (doc === undefined) fail(404, "No such document, or you can't see it.");
      return {
        documentId: doc.id,
        source: doc.id.split(":")[0]!,
        kind: doc.kind,
        title: doc.title,
        url: doc.url,
        scope: doc.scope,
        scopeLabel: scopeLabel(doc.scope),
        author: doc.author ?? null,
        updatedAt: doc.updatedAt,
        text: doc.body.slice(0, cap),
        truncated: doc.body.length > cap,
      } satisfies DocumentText;
    },

    async stats(signal) {
      await sleep(latency / 2, signal);
      if (!me.isAdmin) fail(403);
      const bySource = new Map<string, number>();
      for (const doc of documents) {
        const source = doc.id.split(":")[0]!;
        bySource.set(source, (bySource.get(source) ?? 0) + 1);
      }
      return {
        documents: documents.length,
        deletedDocuments: 3,
        chunks: documents.length * 2 + 11,
        pendingEmbeds,
        tombstones: 3,
        scopes: FIXTURE_SCOPES.length,
        principals: 14,
        bySource: [...bySource.entries()].map(([source, count]) => ({ source, documents: count })),
      } satisfies IndexStats;
    },

    async requeue() {
      await sleep(latency, undefined);
      if (!me.isAdmin) fail(403);
      const queued = pendingEmbeds;
      pendingEmbeds = 0;
      return queued;
    },
  };
}
