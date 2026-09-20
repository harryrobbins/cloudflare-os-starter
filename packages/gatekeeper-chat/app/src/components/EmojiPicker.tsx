// The emoji picker. A small built-in set (see lib/emoji.ts) rather than a 1,800-entry data file: custom
// emoji are explicitly out of scope for v1, and a picker that loads half a megabyte to offer a thumbs-up
// is not a trade this app needs to make.

import { MagnifyingGlass } from "@phosphor-icons/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ALL_EMOJI, EMOJI_GROUPS, type EmojiEntry } from "../lib/emoji.js";
import { quickReactions, subscribeQuickReactions } from "../lib/reactions.js";

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const quickPicks = useSyncExternalStore(subscribeQuickReactions, quickReactions, quickReactions);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      // The same row the hover bar offers, at the top: a picker whose first row is what you always
      // reach for turns two decisions into none.
      const frequent: EmojiEntry[] = quickPicks.map(
        (emoji) => ALL_EMOJI.find((entry) => entry.emoji === emoji) ?? { emoji, name: emoji },
      );
      return [{ label: "Frequently used", entries: frequent }, ...EMOJI_GROUPS];
    }
    const matches = ALL_EMOJI.filter(
      (entry) =>
        entry.name.includes(needle) ||
        (entry.keywords ?? []).some((keyword) => keyword.includes(needle)),
    );
    return [{ label: `${matches.length} matches`, entries: matches }];
  }, [query, quickPicks]);

  return (
    <>
      <div className="fixed inset-0 z-[1200]" aria-hidden="true" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-label="Pick an emoji"
        className="absolute top-6 right-4 z-[1201] w-72 overflow-hidden rounded-xl border border-kumo-line bg-kumo-control shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-kumo-line px-3 py-2">
          <MagnifyingGlass size={14} className="shrink-0 text-kumo-inactive" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="w-full bg-transparent text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
        </div>
        <div className="quiet-scroll max-h-64 overflow-y-auto p-2">
          {groups.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">
                {group.label}
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {group.entries.map((entry) => (
                  <button
                    key={`${group.label}:${entry.name}`}
                    type="button"
                    onClick={() => onPick(entry.emoji)}
                    aria-label={entry.name}
                    title={`:${entry.name}:`}
                    className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[17px] transition-colors hover:bg-kumo-tint"
                  >
                    <span aria-hidden="true">{entry.emoji}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {groups[0]?.entries.length === 0 && (
            <p className="px-1 py-6 text-center text-[12px] text-kumo-subtle">No emoji match that.</p>
          )}
        </div>
      </div>
    </>
  );
}
