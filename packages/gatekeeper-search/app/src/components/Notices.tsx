import { Info } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { DenseStatus } from "../contract.js";

/** A quiet line when the meaning-based half did not run. Nothing when it did. */
export function DenseNotice({ dense }: { dense: DenseStatus }): ReactNode {
  if (dense === "ok") return null;
  const text =
    dense === "unavailable"
      ? "Meaning-based results unavailable, showing word matches."
      : "Meaning-based search is off, showing word matches.";
  return (
    <p role="status" className="flex items-center gap-1.5 rounded-md bg-info-tint px-3 py-1.5 text-xs text-info">
      <Info size={14} aria-hidden="true" />
      {text}
    </p>
  );
}

export const FRESHNESS_NOTE =
  "New content is searchable by its words straight away, and by meaning a few seconds after it appears.";
