// What the page shows before anything is typed: what is searchable, how to narrow a search, and the
// keys. Examples are buttons that put the example into the box.

import type { ReactNode } from "react";

import type { SourceSummary } from "../contract.js";
import { formatCount, relativeTime } from "../lib/format.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { SourceDot, sourceLabel } from "./SourceBadge.js";

export const SYNTAX_HELP: { example: string; meaning: string }[] = [
  { example: "in:#design", meaning: "in one channel or collection" },
  { example: "from:me", meaning: "written by a person" },
  { example: "source:context", meaning: "one source: chat, context, gadget" },
  { example: "kind:doc", meaning: "one kind: message, doc, sheet, slides…" },
  { example: "workspace:ws-atlas", meaning: "one workspace" },
  { example: "after:2026-09-01", meaning: "updated after a day (also before:, on:)" },
  { example: "launch*", meaning: "a trailing * matches word starts" },
];

export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["/"], action: "focus search" },
  { keys: ["↓", "↑"], action: "move through results" },
  { keys: ["Enter"], action: "open the result" },
  { keys: ["Space", "→"], action: "preview" },
  { keys: ["Esc"], action: "close preview, then clear" },
];

export function EmptyState({
  sources,
  sourcesError,
  onExample,
}: {
  sources: SourceSummary[] | null;
  sourcesError: unknown;
  onExample: (example: string) => void;
}): ReactNode {
  return (
    <div className="grid gap-8 py-4 md:grid-cols-2">
      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="text-sm font-semibold text-strong">
          What you can search
        </h2>
        {sourcesError !== null && sourcesError !== undefined ? (
          <div className="mt-3">
            <ErrorNotice error={sourcesError} compact />
          </div>
        ) : sources === null ? (
          <div className="mt-3 flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="skeleton h-12" />
            ))}
          </div>
        ) : sources.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing is indexed yet. Sources appear here once they send documents.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {sources.map((source) => (
              <li key={source.source}>
                <button
                  type="button"
                  onClick={() => onExample(`source:${source.source}`)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-ring"
                >
                  <SourceDot source={source.source} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-strong">
                      {source.label.length > 0 && source.label !== source.source ? source.label : sourceLabel(source.source)}
                    </span>
                    <span className="block text-xs text-muted">
                      {source.lastUpdatedAt === null ? "No updates yet" : `Updated ${relativeTime(source.lastUpdatedAt)}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">
                    {formatCount(source.documents)} {source.documents === 1 ? "document" : "documents"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="syntax-heading">
        <h2 id="syntax-heading" className="text-sm font-semibold text-strong">
          Narrow a search
        </h2>
        <p className="mt-1 text-sm text-muted">
          Type words to match by words and by meaning, and add any of these. Select a filter on the left of the
          results to add one for you.
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
          {SYNTAX_HELP.map((row) => (
            <div key={row.example} className="contents">
              <dt>
                <button
                  type="button"
                  onClick={() => onExample(row.example)}
                  className="cursor-pointer rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-xs text-fg hover:border-ring"
                >
                  {row.example}
                </button>
              </dt>
              <dd className="text-muted">{row.meaning}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-6 text-sm font-semibold text-strong">Keys</h3>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
          {SHORTCUTS.map((row) => (
            <li key={row.action} className="flex items-center gap-2">
              <span className="flex gap-1">
                {row.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              {row.action}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
