// Ctrl/Cmd+K: go anywhere.
//
// One list over two kinds of thing -- conversations and people -- because that is how the question is
// asked ("take me to Alice", "take me to design") and sorting them into two panes makes the user do
// the classification. `#` and `@` narrow it when the answer is ambiguous.
//
// With nothing typed, the list is recency: the four or five places you have been today are almost
// always where you want to go next, and a switcher that opens on an alphabetical list of every
// channel makes you type to get back to the one you just left.

import { Hash, LockSimple, MagnifyingGlass, Users } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Channel, User } from "../contract.js";
import { highlightRuns, rankItems } from "../lib/fuzzy.js";
import { channelLabel, isDirect, otherMemberIds } from "../lib/labels.js";
import { useChat } from "../hooks/store.js";
import { readRecentChannels, recencyRank } from "../store/recents.js";
import { isAgent } from "../lib/agent.js";
import { AppBadge, Avatar, PresenceDot } from "./primitives.js";

type Entry =
  | { readonly kind: "channel"; readonly id: string; readonly label: string; readonly detail: string; readonly channel: Channel }
  | { readonly kind: "person"; readonly id: string; readonly label: string; readonly detail: string; readonly user: User };

export function QuickSwitcher({
  onClose,
  onOpenChannel,
  onOpenPerson,
  onSearch,
}: {
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
  onOpenPerson: (userId: string) => void;
  onSearch: (query: string) => void;
}): ReactNode {
  const channels = useChat((state) => state.channels);
  const memberships = useChat((state) => state.memberships);
  const users = useChat((state) => state.users);
  const online = useChat((state) => state.online);
  const meId = useChat((state) => state.me?.id);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  // Read once, when the switcher opens: re-reading on every keystroke would reorder the list under
  // the caret as navigation writes to the same key.
  const recents = useMemo(() => readRecentChannels(), []);

  /** `#` and `@` are filters, not search text, so they are stripped before matching. */
  const scope = query.startsWith("#") ? "channel" : query.startsWith("@") ? "person" : "any";
  const needle = scope === "any" ? query.trim() : query.slice(1).trim();

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    /** People who already have a one-to-one conversation: that row *is* the destination. */
    const hasDm = new Set<string>();
    if (scope !== "person") {
      for (const channel of Object.values(channels)) {
        if (channel.archived) continue;
        const member = memberships[channel.id] !== undefined;
        // A public channel you are not in is still a destination -- that is what Browse is for, and
        // being able to jump straight there is the point of a switcher.
        if (!member && channel.kind !== "public") continue;
        if (channel.kind === "dm") for (const id of otherMemberIds(channel, meId)) hasDm.add(id);
        out.push({
          kind: "channel",
          id: channel.id,
          label: channelLabel(channel, users, meId),
          detail: member ? (channel.topic ?? "") : "Not joined",
          channel,
        });
      }
    }
    if (scope !== "channel") {
      for (const user of Object.values(users)) {
        if (user.id === meId) continue;
        // Not twice. `@` narrows to people, so there the person row is the only row there is.
        if (hasDm.has(user.id)) continue;
        out.push({ kind: "person", id: user.id, label: user.name, detail: user.email ?? "", user });
      }
    }
    return out;
  }, [channels, memberships, users, meId, scope]);

  const ranked = useMemo(() => {
    const results = rankItems(
      entries,
      needle,
      (entry) => entry.label,
      (entry) => {
        // Recency dominates an empty query and breaks ties in a typed one. A person has no recency
        // of their own, so they inherit the conversation's when there is one.
        const rank = entry.kind === "channel" ? recencyRank(recents, entry.id) : Number.POSITIVE_INFINITY;
        const recencyBonus = rank === Number.POSITIVE_INFINITY ? 0 : 60 - rank * 4;
        const memberBonus = entry.kind === "channel" && memberships[entry.id] !== undefined ? 8 : 0;
        return recencyBonus + memberBonus;
      },
    );
    return results.slice(0, 12);
  }, [entries, needle, recents, memberships]);

  useEffect(() => setActiveIndex(0), [query]);

  // Focus in, focus back out. The same contract `Modal` offers, without its header and padding.
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    return () => restoreTo.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, ranked]);

  const searchRow = needle.length > 0;
  const rowCount = ranked.length + (searchRow ? 1 : 0);

  function choose(index: number): void {
    if (searchRow && index === ranked.length) {
      onSearch(needle);
      onClose();
      return;
    }
    const entry = ranked[index]?.item;
    if (entry === undefined) return;
    if (entry.kind === "channel") onOpenChannel(entry.id);
    else onOpenPerson(entry.id);
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (rowCount === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % rowCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + rowCount) % rowCount);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(rowCount - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1250] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Go to a conversation"
        data-testid="quick-switcher"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="chat-rise flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-kumo-line px-3.5 py-3">
          <MagnifyingGlass size={16} className="shrink-0 text-kumo-inactive" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a channel or a person…"
            aria-label="Jump to a channel or a person"
            role="combobox"
            aria-expanded={rowCount > 0}
            aria-controls="quick-switcher-list"
            aria-activedescendant={`quick-switcher-row-${activeIndex}`}
            className="w-full bg-transparent text-[14px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
          <kbd className="hidden shrink-0 rounded border border-kumo-line px-1.5 py-0.5 font-sans text-[10px] text-kumo-inactive sm:block">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="quick-switcher-list"
          role="listbox"
          aria-label="Destinations"
          className="quiet-scroll max-h-[50vh] min-h-0 overflow-y-auto py-1"
        >
          {ranked.map((result, index) => (
            <Row
              key={`${result.item.kind}:${result.item.id}`}
              index={index}
              active={index === activeIndex}
              entry={result.item}
              positions={result.positions}
              online={online}
              meId={meId}
              users={users}
              onHover={() => setActiveIndex(index)}
              onPick={() => choose(index)}
            />
          ))}

          {searchRow && (
            <button
              type="button"
              role="option"
              id={`quick-switcher-row-${ranked.length}`}
              aria-selected={activeIndex === ranked.length}
              data-active={activeIndex === ranked.length ? "true" : "false"}
              onMouseEnter={() => setActiveIndex(ranked.length)}
              onClick={() => choose(ranked.length)}
              className={[
                "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors",
                ranked.length > 0 ? "mt-1 border-t border-kumo-line pt-2.5" : "",
                activeIndex === ranked.length ? "bg-kumo-tint" : "",
              ].join(" ")}
            >
              <MagnifyingGlass size={15} className="shrink-0 text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate text-kumo-default">
                Search messages for “{needle}”
              </span>
              <kbd className="shrink-0 rounded border border-kumo-line px-1.5 py-0.5 font-sans text-[10px] text-kumo-inactive">
                ↵
              </kbd>
            </button>
          )}

          {rowCount === 0 && (
            <p className="px-3.5 py-6 text-center text-[12px] text-kumo-subtle">
              Nothing matches that.
            </p>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-kumo-line px-3.5 py-2 text-[11px] text-kumo-inactive">
          <span>
            <kbd className="font-sans font-medium">↑↓</kbd> to move
          </span>
          <span>
            <kbd className="font-sans font-medium">↵</kbd> to open
          </span>
          <span>
            <kbd className="font-sans font-medium">#</kbd> channels only
          </span>
          <span>
            <kbd className="font-sans font-medium">@</kbd> people only
          </span>
        </p>
      </div>
    </div>
  );
}

function Row({
  entry,
  positions,
  index,
  active,
  online,
  users,
  meId,
  onHover,
  onPick,
}: {
  entry: Entry;
  positions: readonly number[];
  index: number;
  active: boolean;
  online: readonly string[];
  users: Readonly<Record<string, User>>;
  meId: string | undefined;
  onHover: () => void;
  onPick: () => void;
}): ReactNode {
  const otherId =
    entry.kind === "channel" && entry.channel.kind === "dm"
      ? otherMemberIds(entry.channel, meId)[0]
      : undefined;

  return (
    <button
      type="button"
      role="option"
      id={`quick-switcher-row-${index}`}
      aria-selected={active}
      data-active={active ? "true" : "false"}
      onMouseEnter={onHover}
      onClick={onPick}
      className={[
        "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left transition-colors",
        active ? "bg-kumo-tint" : "",
      ].join(" ")}
    >
      <span className="flex w-5 shrink-0 justify-center">
        {entry.kind === "person" ? (
          <Avatar name={entry.user.name} id={entry.user.id} size={20} />
        ) : otherId !== undefined ? (
          <Avatar name={users[otherId]?.name ?? "?"} id={otherId} size={20} />
        ) : isDirect(entry.channel) ? (
          <Users size={15} className="text-kumo-subtle" />
        ) : entry.channel.kind === "private" ? (
          <LockSimple size={15} className="text-kumo-subtle" />
        ) : (
          <Hash size={15} className="text-kumo-subtle" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">
        {highlightRuns(entry.label, positions).map((run, runIndex) =>
          run.hit ? (
            <b key={runIndex} className="font-semibold text-kumo-brand">
              {run.text}
            </b>
          ) : (
            <span key={runIndex}>{run.text}</span>
          ),
        )}
      </span>
      {entry.kind === "person" && !isAgent(entry.user) && (
        <PresenceDot online={online.includes(entry.user.id)} className="h-2 w-2 shrink-0" />
      )}
      {entry.kind === "person" && isAgent(entry.user) && <AppBadge className="shrink-0" />}
      {entry.detail.length > 0 && (
        <span className="max-w-[45%] shrink-0 truncate text-[11px] text-kumo-inactive">
          {entry.detail}
        </span>
      )}
    </button>
  );
}
