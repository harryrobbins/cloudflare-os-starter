// Runs GET api/search for the committed query, keeps the previous results on screen while the next
// ones load, aborts superseded requests, and appends pages for "Load more".

import { useCallback, useEffect, useRef, useState } from "react";

import type { OmniHit, OmniSearchResult } from "../contract.js";
import { isAbort, type SearchApi } from "../api/client.js";

export interface SearchState {
  /** The query the current `result` answers. */
  q: string;
  status: "idle" | "loading" | "ok" | "error";
  /** The first page's result (query, facets, dense status); later pages only add hits. */
  result: OmniSearchResult | null;
  hits: OmniHit[];
  cursor: string | null;
  error: unknown;
  loadingMore: boolean;
  moreError: unknown;
}

const IDLE: SearchState = {
  q: "",
  status: "idle",
  result: null,
  hits: [],
  cursor: null,
  error: null,
  loadingMore: false,
  moreError: null,
};

export function useSearch(api: SearchApi, q: string): { state: SearchState; loadMore: () => void; retry: () => void } {
  const [state, setState] = useState<SearchState>(IDLE);
  const [attempt, setAttempt] = useState(0);
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    moreController.current?.abort();
    if (q.trim().length === 0) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, status: "loading", error: null, moreError: null, loadingMore: false }));
    api
      .search({ q, facets: true }, controller.signal)
      .then((result) => {
        setState({
          q,
          status: "ok",
          result,
          hits: result.hits,
          cursor: result.cursor,
          error: null,
          loadingMore: false,
          moreError: null,
        });
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setState({ ...IDLE, q, status: "error", error });
      });
    return () => controller.abort();
  }, [api, q, attempt]);

  // A mirror of the state for `loadMore`, which must not start a request inside a state updater
  // (StrictMode runs updaters twice).
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.cursor === null || current.loadingMore || current.status !== "ok") return;
    const controller = new AbortController();
    moreController.current = controller;
    const { q: forQ, cursor } = current;
    setState((latest) => ({ ...latest, loadingMore: true, moreError: null }));
    stateRef.current = { ...current, loadingMore: true };
    api
      .search({ q: forQ, cursor, facets: false }, controller.signal)
      .then((page) => {
        setState((latest) =>
          latest.q !== forQ || latest.cursor !== cursor
            ? latest
            : { ...latest, hits: [...latest.hits, ...page.hits], cursor: page.cursor, loadingMore: false },
        );
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setState((latest) => ({ ...latest, loadingMore: false, moreError: error }));
      });
  }, [api]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, loadMore, retry };
}
