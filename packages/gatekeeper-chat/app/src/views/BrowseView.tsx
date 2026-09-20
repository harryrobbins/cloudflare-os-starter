// Browse channels: every public channel, joined or not.

import { Hash, LockSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";

import { pluralise } from "../lib/format.js";
import { isGeneral } from "../lib/labels.js";
import { useChat, useStore } from "../hooks/store.js";
import { Button, EmptyState } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function BrowseView({
  onOpen,
  onNewChannel,
  onBack,
}: {
  onOpen: (channelId: string) => void;
  onNewChannel: () => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const channels = useChat((state) => state.channels);
  const memberships = useChat((state) => state.memberships);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(channels)
      .filter((channel) => channel.name !== null)
      .filter((channel) => showArchived || !channel.archived)
      .filter(
        (channel) =>
          needle.length === 0 ||
          channel.name?.includes(needle) === true ||
          channel.topic?.toLowerCase().includes(needle) === true,
      )
      .toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [channels, query, showArchived]);

  return (
    <ViewShell
      title="Browse channels"
      subtitle={`${listed.length} channels`}
      {...(onBack === undefined ? {} : { onBack })}
      actions={
        <Button size="sm" variant="primary" onClick={onNewChannel}>
          New channel
        </Button>
      }
    >
      <div className="sticky top-0 z-[1] flex items-center gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 field focus-within:border-kumo-brand">
          <MagnifyingGlass size={14} className="shrink-0 text-kumo-inactive" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search channels"
            aria-label="Search channels"
            className="w-full bg-transparent py-2 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-kumo-subtle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-kumo-brand)]"
          />
          Archived
        </label>
      </div>

      {listed.length === 0 ? (
        <EmptyState
          icon={<Hash size={20} />}
          title="No channels match that"
          action={
            <Button variant="primary" onClick={onNewChannel}>
              Create one
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-kumo-line">
          {listed.map((channel) => {
            const joined = memberships[channel.id] !== undefined;
            return (
              <li key={channel.id} className="group flex items-start gap-3 px-4 py-3.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-subtle">
                  {channel.kind === "private" ? <LockSimple size={15} /> : <Hash size={15} />}
                </span>
                <button
                  type="button"
                  onClick={() => onOpen(channel.id)}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-kumo-strong">
                      {channel.name}
                    </span>
                    {channel.archived && (
                      <span className="shrink-0 rounded bg-kumo-fill px-1.5 py-px text-[10px] text-kumo-subtle">
                        archived
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[12px] text-kumo-subtle">
                    {channel.topic ?? channel.purpose ?? "No topic yet"}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-kumo-inactive">
                    {pluralise(channel.memberCount, "member")}
                  </span>
                </button>
                {joined ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isGeneral(channel)}
                    title={isGeneral(channel) ? "#general cannot be left." : undefined}
                    onClick={() => void store.leaveChannel(channel.id)}
                  >
                    Leave
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => void store.joinChannel(channel.id)}>
                    Join
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ViewShell>
  );
}
