// The frame every non-conversation view shares: a header with an optional back affordance, and a
// scrolling body. Keeping it here is what makes Threads, Mentions, Drafts, Search, People and Browse
// line up to the pixel.

import { List } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { IconButton } from "../components/primitives.js";

export function ViewShell({
  title,
  subtitle,
  actions,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    // `flex-1` matters: the shell's <main> is a flex row, and without it every list view would be
    // as wide as its widest row rather than the pane.
    <div className="flex h-full min-w-0 flex-1 flex-col bg-kumo-base">
      {/* The header rule spans the pane, but its contents share the body's centred column so the title
          lines up with the first row beneath it. */}
      <header className="flex h-14 shrink-0 items-center border-b border-kumo-line px-3 md:px-4">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2">
          {onBack !== undefined && (
            <IconButton label="Conversations" onClick={onBack}>
              <List size={16} />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold text-kumo-strong">{title}</h1>
            {subtitle !== undefined && (
              <p className="truncate text-[11px] text-kumo-subtle">{subtitle}</p>
            )}
          </div>
          {actions}
        </div>
      </header>
      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto">
        {/* A centred column: a 1,400px-wide list of one-line rows reads badly, and every view here is
            a list. The header stays full width so it lines up with the conversation's own. */}
        <div className="mx-auto w-full max-w-4xl">{children}</div>
      </div>
    </div>
  );
}
