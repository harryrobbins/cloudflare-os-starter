import { useMemo, type ReactNode } from "react";

import { sanitizeSnippet } from "../lib/snippet.js";

/** A server snippet, rebuilt as text nodes: only `<mark>` survives (lib/snippet.ts). */
export function Snippet({ html, className }: { html: string; className?: string }): ReactNode {
  const segments = useMemo(() => sanitizeSnippet(html), [html]);
  return (
    <p className={`snippet ${className ?? ""}`}>
      {segments.map((segment, index) =>
        segment.mark ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
      )}
    </p>
  );
}
