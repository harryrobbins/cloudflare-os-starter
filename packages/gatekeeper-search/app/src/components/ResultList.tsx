// The result listbox. Focus sits on the list itself and `aria-activedescendant` names the selected
// row, so arrow keys never fight the browser's own focus movement; see lib/keys.ts for the keymap.

import { ArrowSquareOut, Sparkle, TextAa } from "@phosphor-icons/react";
import { forwardRef, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import type { OmniHit } from "../contract.js";
import { absoluteTime, relativeTime } from "../lib/format.js";
import { listKeyAction } from "../lib/keys.js";
import { linkTarget } from "../lib/links.js";
import { Snippet } from "./Snippet.js";
import { SourceBadge } from "./SourceBadge.js";

export const RESULT_LIST_ID = "results";

export function optionId(index: number): string {
  return `result-${index}`;
}

export interface ResultListProps {
  hits: OmniHit[];
  selected: number;
  previewOpen: boolean;
  /** The preview is showing this document (highlights the row even when the list is not focused). */
  previewId?: string | null;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onPreview: (index: number) => void;
  onClosePreview: () => void;
  onFocusInput: () => void;
  /** Selection reached the last row; the caller may load more. */
  onReachEnd?: () => void;
  now?: number;
}

/** "found by meaning", "found by words", or both. */
export function matchHint(hit: Pick<OmniHit, "lexicalRank" | "denseRank">): { label: string; kind: "words" | "meaning" | "both" } | null {
  const words = hit.lexicalRank !== null;
  const meaning = hit.denseRank !== null;
  if (words && meaning) return { label: "found by words and meaning", kind: "both" };
  if (meaning) return { label: "found by meaning", kind: "meaning" };
  if (words) return { label: "found by words", kind: "words" };
  return null;
}

export const ResultList = forwardRef<HTMLUListElement, ResultListProps>(function ResultList(props, ref) {
  const { hits, selected, previewOpen, onSelect, onOpen, onPreview, onClosePreview, onFocusInput, onReachEnd } = props;
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const row = rowRefs.current[selected];
    // jsdom has no scrollIntoView.
    if (row !== null && row !== undefined && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = listKeyAction(event.key, selected, hits.length, previewOpen);
    if (action.type === "none") return;
    event.preventDefault();
    switch (action.type) {
      case "select":
        onSelect(action.index);
        if (action.index === hits.length - 1) onReachEnd?.();
        break;
      case "focusInput":
        onFocusInput();
        break;
      case "open":
        onOpen(action.index);
        break;
      case "preview":
        onPreview(action.index);
        break;
      case "closePreview":
        onClosePreview();
        break;
    }
  }

  return (
    <ul
      ref={ref}
      id={RESULT_LIST_ID}
      role="listbox"
      aria-label="Search results"
      tabIndex={0}
      aria-activedescendant={selected >= 0 && selected < hits.length ? optionId(selected) : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (selected < 0 && hits.length > 0) onSelect(0);
      }}
      className="results flex flex-col gap-1"
    >
      {hits.map((hit, index) => (
        <ResultRow
          key={`${hit.documentId}-${index}`}
          ref={(node) => {
            rowRefs.current[index] = node;
          }}
          hit={hit}
          index={index}
          selected={index === selected}
          previewing={previewOpen && props.previewId === hit.documentId}
          now={props.now}
          onClick={() => {
            onSelect(index);
            onPreview(index);
          }}
        />
      ))}
    </ul>
  );
});

const ResultRow = forwardRef<
  HTMLLIElement,
  { hit: OmniHit; index: number; selected: boolean; previewing: boolean; now: number | undefined; onClick: () => void }
>(function ResultRow({ hit, index, selected, previewing, now, onClick }, ref): ReactNode {
  const target = linkTarget(hit.url);
  const hint = matchHint(hit);
  return (
    <li
      ref={ref}
      id={optionId(index)}
      role="option"
      aria-selected={selected}
      onClick={(event) => {
        // A click on the title link navigates; anywhere else selects and previews.
        if ((event.target as HTMLElement).closest("a") !== null) return;
        onClick();
      }}
      className={`group cursor-pointer rounded-lg border px-3 py-2.5 transition-colors sm:px-4 ${
        selected
          ? "border-brand/40 bg-selected"
          : previewing
            ? "border-line bg-tint"
            : "border-transparent hover:bg-tint"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <SourceBadge source={hit.source} />
        {hit.scopeLabel !== null && <span className="truncate font-medium text-fg">{hit.scopeLabel}</span>}
        <span aria-hidden="true">·</span>
        <span>{hit.kind}</span>
        {hit.author !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate">{hit.author}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <time dateTime={new Date(hit.updatedAt).toISOString()} title={absoluteTime(hit.updatedAt)}>
          {relativeTime(hit.updatedAt, now)}
        </time>
      </div>
      <h3 className="mt-1 text-[15px] font-semibold leading-snug text-strong">
        {target === null ? (
          <span>{hit.title}</span>
        ) : (
          <a
            href={target.href}
            tabIndex={-1}
            {...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="hover:text-link hover:underline hover:underline-offset-2"
          >
            {hit.title}
            {target.external && (
              <>
                <ArrowSquareOut size={13} className="ml-1 inline align-[-1px] text-faint" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </>
            )}
          </a>
        )}
      </h3>
      <Snippet html={hit.snippet} className="mt-1 line-clamp-3 text-sm leading-relaxed text-fg/90" />
      {hint !== null && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-faint">
          {hint.kind === "words" ? (
            <TextAa size={12} aria-hidden="true" />
          ) : (
            <Sparkle size={12} aria-hidden="true" weight={hint.kind === "meaning" ? "fill" : "regular"} />
          )}
          {hint.label}
        </p>
      )}
    </li>
  );
});
