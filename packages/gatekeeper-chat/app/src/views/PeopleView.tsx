// The people directory. A person appears the first time they sign in to the platform -- the shell tells
// chat once per session -- so the empty and partial states say that rather than implying an invite flow
// that does not exist.

import { MagnifyingGlass, Users } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { formatRelative } from "../lib/format.js";
import { useChat, useStore } from "../hooks/store.js";
import { Avatar, Button, EmptyState, Skeleton } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function PeopleView({
  onOpenDm,
  onBack,
}: {
  onOpenDm: (userId: string) => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const directory = useChat((state) => state.directory);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!directory.loaded) void store.loadDirectory();
  }, [store, directory.loaded]);

  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(users)
      .filter(
        (user) =>
          needle.length === 0 ||
          user.name.toLowerCase().includes(needle) ||
          user.email?.toLowerCase().includes(needle) === true,
      )
      .toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [users, query]);

  return (
    <ViewShell
      title="People"
      subtitle={`${Object.keys(users).length} in this deployment`}
      {...(onBack === undefined ? {} : { onBack })}
    >
      <div className="sticky top-0 z-[1] border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 field focus-within:border-kumo-brand">
          <MagnifyingGlass size={14} className="shrink-0 text-kumo-inactive" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
            className="w-full bg-transparent py-2 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
        </div>
      </div>

      {directory.loading && people.length === 0 ? (
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <EmptyState
          icon={<Users size={20} />}
          title="Nobody matches that"
          body="People appear here the first time they sign in to the platform; nobody is invited or approved."
        />
      ) : (
        <ul className="grid gap-2 p-4 sm:grid-cols-2">
          {people.map((user) => (
            <li
              key={user.id}
              className="flex items-center gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-3"
            >
              <Avatar name={user.name} id={user.id} size={36} online={user.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-kumo-strong">
                  {user.name}
                  {user.id === meId && <span className="text-kumo-inactive"> (you)</span>}
                </p>
                <p className="truncate text-[11px] text-kumo-subtle">
                  {user.online ? "Online now" : `Last seen ${formatRelative(user.lastSeenAt)}`}
                </p>
              </div>
              {user.id !== meId && (
                <Button size="sm" variant="secondary" onClick={() => onOpenDm(user.id)}>
                  Message
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </ViewShell>
  );
}
