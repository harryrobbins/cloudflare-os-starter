import { X } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { Chip } from "../lib/query.js";

const KEY_LABEL: Readonly<Record<Chip["key"], string>> = {
  in: "in",
  from: "from",
  source: "source",
  kind: "kind",
  workspace: "workspace",
  before: "before",
  after: "after",
  on: "on",
};

/** The server's parsed qualifiers, each removable. */
export function Chips({ chips, onRemove }: { chips: Chip[]; onRemove: (chip: Chip) => void }): ReactNode {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Active filters" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li key={chip.id}>
          <button
            type="button"
            onClick={() => onRemove(chip)}
            aria-label={`Remove filter ${KEY_LABEL[chip.key]}: ${chip.label}`}
            className="group inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-panel py-0.5 pl-2.5 pr-1.5 text-xs text-fg transition-colors hover:border-ring"
          >
            <span className="font-mono text-muted">{KEY_LABEL[chip.key]}:</span>
            <span className="max-w-[16rem] truncate font-medium">{chip.label}</span>
            <X size={12} weight="bold" aria-hidden="true" className="text-faint group-hover:text-fg" />
          </button>
        </li>
      ))}
    </ul>
  );
}
