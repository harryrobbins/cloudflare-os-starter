import { Check } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

import type { Facet, FacetField, FacetValue, OmniQuery } from "../contract.js";
import { formatCount, monthLabel } from "../lib/format.js";
import { facetActive } from "../lib/query.js";
import { SourceDot, sourceLabel } from "./SourceBadge.js";

const FIELD_ORDER: FacetField[] = ["source", "kind", "scope", "author", "workspace", "month"];

const FIELD_LABEL: Readonly<Record<FacetField, string>> = {
  source: "Source",
  kind: "Kind",
  scope: "Where",
  author: "Author",
  workspace: "Workspace",
  month: "Updated",
};

/** Values beyond this are behind "Show all". */
const COLLAPSED = 6;

function valueLabel(field: FacetField, value: FacetValue): string {
  if (field === "source") return sourceLabel(value.value);
  if (field === "month") return monthLabel(value.value);
  return value.label.length > 0 ? value.label : value.value;
}

export function FacetRail({
  facets,
  query,
  onToggle,
}: {
  facets: Facet[];
  query: OmniQuery | undefined;
  onToggle: (field: FacetField, value: string) => void;
}): ReactNode {
  const ordered = [...facets]
    .filter((facet) => facet.values.length > 0)
    .sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  if (ordered.length === 0) return <p className="text-sm text-muted">No filters for these results.</p>;
  return (
    <nav aria-label="Filters" className="flex flex-col gap-5">
      {ordered.map((facet) => (
        <FacetGroup key={facet.field} facet={facet} query={query} onToggle={onToggle} />
      ))}
    </nav>
  );
}

function FacetGroup({
  facet,
  query,
  onToggle,
}: {
  facet: Facet;
  query: OmniQuery | undefined;
  onToggle: (field: FacetField, value: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const values = expanded ? facet.values : facet.values.slice(0, COLLAPSED);
  const headingId = `facet-${facet.field}`;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
        {FIELD_LABEL[facet.field]}
      </h2>
      <ul className="flex flex-col">
        {values.map((value) => {
          const active = facetActive(facet.field, value.value, query);
          const label = valueLabel(facet.field, value);
          return (
            <li key={value.value}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onToggle(facet.field, value.value)}
                title={label}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors ${
                  active ? "bg-selected font-medium text-strong" : "text-fg hover:bg-tint"
                }`}
              >
                {facet.field === "source" && <SourceDot source={value.value} />}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {active ? (
                  <Check size={13} weight="bold" className="shrink-0 text-brand" aria-hidden="true" />
                ) : null}
                <span className="shrink-0 tabular-nums text-xs text-faint">
                  {formatCount(value.count)}
                  <span className="sr-only"> results</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {facet.values.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-1 cursor-pointer px-2 text-xs font-medium text-link hover:underline"
        >
          {expanded ? "Show fewer" : `Show all ${facet.values.length}`}
        </button>
      )}
    </section>
  );
}
