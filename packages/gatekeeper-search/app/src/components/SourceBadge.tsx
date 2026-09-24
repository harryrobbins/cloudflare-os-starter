import type { ReactNode } from "react";

import { SOURCE_LABELS } from "../contract.js";

const DOT: Readonly<Record<string, string>> = {
  chat: "bg-src-chat",
  context: "bg-src-context",
  gadget: "bg-src-gadget",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

export function SourceDot({ source }: { source: string }): ReactNode {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${DOT[source] ?? "bg-src-other"}`} />;
}

export function SourceBadge({ source }: { source: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] font-medium text-muted">
      <SourceDot source={source} />
      {sourceLabel(source)}
    </span>
  );
}
