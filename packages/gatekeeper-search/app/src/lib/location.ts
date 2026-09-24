// The query lives in the URL (`?q=`) so a search is linkable and back/forward works. Other params
// (the mock's `?mock=` for instance) are preserved.
//
// History policy: a burst of typing makes one entry — the first debounced commit pushes, later ones
// replace while `history.state.typed` says the top entry came from typing. A chip, a facet or Enter
// always pushes.

export function readQuery(search: string = window.location.search): string {
  return new URLSearchParams(search).get("q") ?? "";
}

export function urlWithQuery(q: string, href: string = window.location.href): string {
  const url = new URL(href);
  if (q.trim().length > 0) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  return `${url.pathname}${url.search}${url.hash}`;
}

export type HistoryMode = "typed" | "push";

export function writeQuery(q: string, mode: HistoryMode): void {
  const next = urlWithQuery(q);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  const typedTop = (window.history.state as { typed?: boolean } | null)?.typed === true;
  if (mode === "typed" && typedTop) window.history.replaceState({ typed: true }, "", next);
  else window.history.pushState({ typed: mode === "typed" }, "", next);
}
