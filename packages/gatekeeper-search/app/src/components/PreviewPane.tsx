// The preview: the full text of the selected hit, from GET api/documents/:id, as plain text with its
// whitespace kept. Documents are cached for the session so moving back and forth is instant.

import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";

import type { DocumentText, OmniHit } from "../contract.js";
import { isAbort, type SearchApi } from "../api/client.js";
import { absoluteTime } from "../lib/format.js";
import { linkTarget } from "../lib/links.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { SourceBadge } from "./SourceBadge.js";

type State =
  | { status: "loading" }
  | { status: "ok"; doc: DocumentText }
  | { status: "error"; error: unknown };

export function PreviewPane({
  api,
  hit,
  cache,
  onClose,
}: {
  api: SearchApi;
  hit: OmniHit;
  cache: Map<string, DocumentText>;
  onClose: () => void;
}): ReactNode {
  const id = hit.documentId;
  const [state, setState] = useState<State>(() => {
    const cached = cache.get(id);
    return cached === undefined ? { status: "loading" } : { status: "ok", doc: cached };
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const cached = cache.get(id);
    if (cached !== undefined) {
      setState({ status: "ok", doc: cached });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    // A short delay so holding an arrow key does not fire a request per row.
    const timer = setTimeout(() => {
      api
        .document(id, controller.signal)
        .then((doc) => {
          cache.set(id, doc);
          setState({ status: "ok", doc });
        })
        .catch((error: unknown) => {
          if (!isAbort(error)) setState({ status: "error", error });
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, cache, id, attempt]);

  const doc = state.status === "ok" ? state.doc : null;
  const target = linkTarget(doc?.url ?? hit.url);
  const title = doc?.title ?? hit.title;

  return (
    <section
      aria-label={`Preview: ${title}`}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <SourceBadge source={hit.source} />
            {(doc?.scopeLabel ?? hit.scopeLabel) !== null && <span>{doc?.scopeLabel ?? hit.scopeLabel}</span>}
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug text-strong">{title}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {[doc?.author ?? hit.author, absoluteTime(doc?.updatedAt ?? hit.updatedAt)].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {target !== null && (
            <a
              href={target.href}
              {...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="inline-flex items-center gap-1 rounded-md bg-contrast px-2.5 py-1 text-xs font-medium text-on-contrast hover:opacity-90"
            >
              Open
              {target.external && <ArrowSquareOut size={12} aria-hidden="true" />}
              {target.external && <span className="sr-only"> (opens in a new tab)</span>}
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="cursor-pointer rounded-md p-1.5 text-muted hover:bg-tint hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-busy={state.status === "loading"}>
        {state.status === "loading" && (
          <div className="flex flex-col gap-2" aria-label="Loading document">
            {[92, 80, 86, 60, 75].map((width, index) => (
              <div key={index} className="skeleton h-3.5" style={{ width: `${width}%` }} />
            ))}
          </div>
        )}
        {state.status === "error" && <ErrorNotice error={state.error} compact onRetry={() => setAttempt((n) => n + 1)} />}
        {doc !== null && (
          <>
            {doc.truncated && (
              <p role="note" className="mb-3 rounded-md bg-warn-tint px-3 py-1.5 text-xs text-warn">
                This document is long, so the preview is truncated. Open it to read the rest.
              </p>
            )}
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-fg">{doc.text}</pre>
          </>
        )}
      </div>
    </section>
  );
}
