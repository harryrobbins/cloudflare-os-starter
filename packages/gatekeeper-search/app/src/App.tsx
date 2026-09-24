// The omni search page: one box, the server's parsed query as chips, a facet rail, a keyboard-driven
// result list and a preview pane.

import { Faders, Gauge, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DocumentText, FacetField, Me, SourceSummary } from "./contract.js";
import { ApiError, isAbort, type SearchApi } from "./api/client.js";
import { AdminPanel } from "./components/AdminPanel.js";
import { Chips } from "./components/Chips.js";
import { EmptyState } from "./components/EmptyState.js";
import { ErrorNotice } from "./components/ErrorNotice.js";
import { FacetRail } from "./components/FacetRail.js";
import { DenseNotice, FRESHNESS_NOTE } from "./components/Notices.js";
import { PreviewPane } from "./components/PreviewPane.js";
import { RESULT_LIST_ID, ResultList } from "./components/ResultList.js";
import { formatCount } from "./lib/format.js";
import { isTypingTarget } from "./lib/keys.js";
import { linkTarget, openLink, type LinkTarget } from "./lib/links.js";
import { readQuery, writeQuery, type HistoryMode } from "./lib/location.js";
import { chipsFromQuery, removeChip, toggleFacet, type Chip } from "./lib/query.js";
import { useSearch } from "./lib/useSearch.js";

export const DEBOUNCE_MS = 220;

export interface AppProps {
  api: SearchApi;
  /** How a result is followed; injectable for tests. */
  navigate?: (target: LinkTarget) => void;
}

export function App({ api, navigate = openLink }: AppProps): ReactNode {
  const [input, setInput] = useState(() => readQuery());
  const [committed, setCommitted] = useState(() => readQuery().trim());
  const { state, loadMore, retry } = useSearch(api, committed);
  const [selected, setSelected] = useState(-1);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState<unknown>(null);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [sourcesError, setSourcesError] = useState<unknown>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docCache = useMemo(() => new Map<string, DocumentText>(), []);

  // --- Query plumbing ------------------------------------------------------------------------

  const commit = useCallback((q: string, mode: HistoryMode) => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = null;
    const trimmed = q.trim();
    setCommitted(trimmed);
    writeQuery(trimmed, mode);
  }, []);

  const replaceQuery = useCallback(
    (q: string) => {
      setInput(q);
      commit(q, "push");
      inputRef.current?.focus();
    },
    [commit],
  );

  useEffect(() => {
    const onPop = (): void => {
      if (debounce.current !== null) clearTimeout(debounce.current);
      const q = readQuery();
      setInput(q);
      setCommitted(q.trim());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => () => {
    if (debounce.current !== null) clearTimeout(debounce.current);
  }, []);

  function onInputChange(value: string): void {
    setInput(value);
    if (debounce.current !== null) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => commit(value, "typed"), DEBOUNCE_MS);
  }

  // A new query resets the selection and closes the preview.
  useEffect(() => {
    setSelected(-1);
    setPreviewOpen(false);
  }, [committed]);

  // --- Identity and sources ------------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then(setMe)
      .catch((error: unknown) => {
        if (!isAbort(error) && error instanceof ApiError && error.code === "unauthenticated") setAuthError(error);
      });
    api
      .sources(controller.signal)
      .then(setSources)
      .catch((error: unknown) => {
        if (!isAbort(error)) setSourcesError(error);
      });
    return () => controller.abort();
  }, [api]);

  // `autoFocus` alone is not reliable across a StrictMode remount; focus once after mount as well.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // --- Global keys ---------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- Derived -------------------------------------------------------------------------------

  const result = state.result;
  const hits = state.hits;
  const scopeLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const facet of result?.facets ?? []) {
      if (facet.field !== "scope") continue;
      for (const value of facet.values) labels.set(value.value, value.label);
    }
    for (const hit of hits) if (hit.scopeLabel !== null) labels.set(hit.scope, hit.scopeLabel);
    return labels;
  }, [result, hits]);
  const chips = useMemo(() => (result === null ? [] : chipsFromQuery(result.query, scopeLabels)), [result, scopeLabels]);
  const selectedHit = selected >= 0 ? hits[selected] : undefined;
  const showPreview = previewOpen && selectedHit !== undefined;
  const searching = committed.length > 0;

  // --- Actions -------------------------------------------------------------------------------

  const openHit = useCallback(
    (index: number) => {
      const hit = hits[index];
      if (hit === undefined) return;
      const target = linkTarget(hit.url);
      if (target === null) {
        setSelected(index);
        setPreviewOpen(true);
        return;
      }
      navigate(target);
    },
    [hits, navigate],
  );

  function focusInput(): void {
    inputRef.current?.focus();
  }

  function onRemoveChip(chip: Chip): void {
    replaceQuery(removeChip(committed, chip));
  }

  function onToggleFacet(field: FacetField, value: string): void {
    replaceQuery(toggleFacet(committed, field, value, result?.query));
  }

  function onExample(example: string): void {
    const next = input.trim().length > 0 ? `${input.trim()} ${example}` : example;
    replaceQuery(next);
  }

  // --- Render --------------------------------------------------------------------------------

  const status =
    !searching
      ? ""
      : state.status === "loading" && state.q !== committed
        ? "Searching…"
        : state.status === "error"
          ? "Search failed."
          : state.status === "ok"
            ? hits.length === 0
              ? "No results."
              : `${formatCount(hits.length)} ${hits.length === 1 ? "result" : "results"}${state.cursor !== null ? ", more available" : ""}.`
            : "";

  return (
    <div className="flex min-h-dvh flex-col">
      <a href={`#${RESULT_LIST_ID}`} className="sr-only-focusable absolute left-2 top-2 z-50 rounded-md bg-contrast px-3 py-1.5 text-sm text-on-contrast">
        Skip to results
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-page/95 backdrop-blur supports-[backdrop-filter]:bg-page/80">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2.5 px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-strong">
              <MagnifyingGlass size={16} weight="bold" className="text-brand" aria-hidden="true" />
              <span className="hidden sm:inline">Search</span>
            </h1>
            <form
              role="search"
              className="field flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-control px-3"
              onSubmit={(event) => {
                event.preventDefault();
                commit(input, "push");
              }}
            >
              <label htmlFor="omni-q" className="sr-only">
                Search everything
              </label>
              <input
                id="omni-q"
                ref={inputRef}
                type="search"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                value={input}
                maxLength={512}
                aria-controls={RESULT_LIST_ID}
                aria-describedby="omni-hint"
                placeholder="Search chat, docs and gadgets — try atlas kind:doc"
                onChange={(event) => onInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    if (input.length > 0) replaceQuery("");
                    return;
                  }
                  if (event.key === "ArrowDown" && hits.length > 0) {
                    event.preventDefault();
                    if (selected < 0) setSelected(0);
                    listRef.current?.focus();
                  }
                }}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-[15px] text-fg outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
              />
              {input.length > 0 && (
                <button
                  type="button"
                  onClick={() => replaceQuery("")}
                  aria-label="Clear search"
                  className="shrink-0 cursor-pointer rounded p-0.5 text-faint hover:text-fg"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
              <kbd aria-hidden="true" className="hidden sm:inline-block">
                /
              </kbd>
            </form>
            {me?.isAdmin === true && (
              <button
                type="button"
                onClick={() => setAdminOpen((open) => !open)}
                aria-expanded={adminOpen}
                aria-controls="admin-panel"
                className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors ${
                  adminOpen ? "border-brand/40 bg-selected text-strong" : "border-line text-muted hover:text-fg"
                }`}
              >
                <Gauge size={15} aria-hidden="true" />
                <span className="hidden sm:inline">Index</span>
              </button>
            )}
          </div>
          <p id="omni-hint" className="sr-only">
            Press down arrow to move into the results. Qualifiers such as in:, from:, source:, kind:, before: and after:
            narrow the search.
          </p>
          <Chips chips={chips} onRemove={onRemoveChip} />
        </div>
        {state.status === "loading" && (
          <div className="relative h-0.5 overflow-hidden" aria-hidden="true">
            <div className="progress-bar absolute inset-y-0 w-1/3 bg-brand" />
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">
        {authError !== null && (
          <div className="mb-4">
            <ErrorNotice error={authError} />
          </div>
        )}
        {adminOpen && me?.isAdmin === true && (
          <div id="admin-panel" className="mb-4">
            <AdminPanel api={api} />
          </div>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>

        {!searching ? (
          <>
            <EmptyState sources={sources} sourcesError={sourcesError} onExample={onExample} />
            <p className="mt-6 text-xs text-faint">{FRESHNESS_NOTE}</p>
          </>
        ) : (
          <div
            className={`grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)] ${
              showPreview ? "lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,28rem)]" : ""
            }`}
          >
            <aside className="md:sticky md:top-32 md:max-h-[calc(100dvh-9rem)] md:self-start md:overflow-y-auto quiet-scroll">
              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-expanded={filtersOpen}
                aria-controls="facet-rail"
                className="mb-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-fg md:hidden"
              >
                <Faders size={14} aria-hidden="true" />
                {filtersOpen ? "Hide filters" : "Filters"}
              </button>
              <div id="facet-rail" className={`${filtersOpen ? "block" : "hidden"} md:block`}>
                {result !== null ? (
                  <FacetRail facets={result.facets} query={result.query} onToggle={onToggleFacet} />
                ) : state.status === "loading" ? (
                  <div className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((index) => (
                      <div key={index} className="skeleton h-5" />
                    ))}
                  </div>
                ) : null}
              </div>
            </aside>

            <section aria-label="Results" className="min-w-0">
              <div className="mb-2 flex flex-col gap-2">
                {result !== null && <DenseNotice dense={result.dense} />}
                {state.status === "ok" && hits.length > 0 && (
                  <p className="text-xs text-faint" aria-hidden="true">
                    {status.replace(/\.$/u, "")} · {result?.tookMs ?? 0} ms
                  </p>
                )}
              </div>

              {state.status === "error" ? (
                <ErrorNotice error={state.error} onRetry={retry} />
              ) : state.status === "loading" && result === null ? (
                <div className="flex flex-col gap-3" aria-label="Loading results">
                  {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="skeleton h-20" />
                  ))}
                </div>
              ) : state.status === "ok" && hits.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
                  <p className="text-sm font-medium text-strong">Nothing matches “{committed}”.</p>
                  <p className="mt-1 text-sm text-muted">
                    {chips.length > 0 ? "Try removing a filter above, or use fewer words." : "Try fewer or different words."}
                  </p>
                </div>
              ) : (
                <div className={state.status === "loading" ? "opacity-60 transition-opacity" : ""}>
                  <ResultList
                    ref={listRef}
                    hits={hits}
                    selected={selected}
                    previewOpen={showPreview}
                    previewId={selectedHit?.documentId ?? null}
                    onSelect={setSelected}
                    onOpen={openHit}
                    onPreview={(index) => {
                      setSelected(index);
                      setPreviewOpen(true);
                    }}
                    onClosePreview={() => setPreviewOpen(false)}
                    onFocusInput={focusInput}
                    onReachEnd={loadMore}
                  />
                  {state.moreError !== null && (
                    <div className="mt-3">
                      <ErrorNotice error={state.moreError} compact onRetry={loadMore} />
                    </div>
                  )}
                  {state.cursor !== null && (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={state.loadingMore}
                        className="cursor-pointer rounded-md border border-line bg-control px-4 py-1.5 text-sm font-medium text-fg hover:border-ring disabled:cursor-wait disabled:opacity-60"
                      >
                        {state.loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <p className="mt-6 text-xs text-faint">{FRESHNESS_NOTE}</p>
            </section>

            {showPreview && selectedHit !== undefined && (
              <div className="fixed inset-0 z-30 bg-page p-2 lg:sticky lg:inset-auto lg:top-32 lg:z-auto lg:h-[calc(100dvh-9rem)] lg:bg-transparent lg:p-0">
                <PreviewPane
                  api={api}
                  hit={selectedHit}
                  cache={docCache}
                  onClose={() => {
                    setPreviewOpen(false);
                    listRef.current?.focus();
                  }}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
