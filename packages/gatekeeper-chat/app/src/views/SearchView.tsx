// Search.
//
// The input is qualifier-aware: the parsed qualifiers the *server* returned are shown as chips, so what
// the UI claims to have searched is what was actually run rather than the client's own guess. Results
// are grouped by conversation, newest first, with the FTS5 snippet's highlights and a Jump.

import { Hash, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { SearchHit, SearchQuery } from "../contract.js";
import { channelLabel } from "../lib/labels.js";
import { formatListTime } from "../lib/format.js";
import { useChat, useStore } from "../hooks/store.js";
import { Snippet } from "../components/Markdown.js";
import { Avatar, Button, EmptyState, Skeleton } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

const QUALIFIER_HELP = [
  "in:#design",
  "from:@alice",
  "to:me",
  "has:image",
  "has:file",
  "has:link",
  "is:thread",
  "before:2026-09-01",
  "after:2026-08-01",
];

export function SearchView({
  initialQuery,
  onQueryChange,
  onJump,
  onOpenChannel,
  onBack,
}: {
  initialQuery: string;
  onQueryChange: (query: string) => void;
  onJump: (channelId: string, messageId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const search = useChat((state) => state.search);
  const channels = useChat((state) => state.channels);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(initialQuery);
    if (initialQuery.trim().length > 0) void store.runSearch(initialQuery);
  }, [initialQuery, store]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const grouped = useMemo(() => {
    const byChannel = new Map<string, SearchHit[]>();
    for (const hit of search.result?.hits ?? []) {
      const list = byChannel.get(hit.channelId) ?? [];
      list.push(hit);
      byChannel.set(hit.channelId, list);
    }
    return [...byChannel.entries()];
  }, [search.result]);

  function submit(next: string): void {
    onQueryChange(next);
    void store.runSearch(next);
  }

  const hitCount = search.result?.hits.length ?? 0;

  return (
    <ViewShell
      title="Search"
      subtitle={
        search.result === null ? "Messages, channels and people" : `${hitCount} ${hitCount === 1 ? "result" : "results"}`
      }
      {...(onBack === undefined ? {} : { onBack })}
    >
      <div className="sticky top-0 z-[2] border-b border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 field focus-within:border-kumo-brand">
          <MagnifyingGlass size={15} className="shrink-0 text-kumo-inactive" />
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(value);
              if (event.key === "Escape") {
                setValue("");
                submit("");
              }
            }}
            placeholder="Search messages — try in:#design from:@alice has:image"
            aria-label="Search messages"
            className="w-full bg-transparent py-2.5 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setValue("");
                submit("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="cursor-pointer text-kumo-inactive hover:text-kumo-default"
            >
              <X size={14} />
            </button>
          )}
          <Button size="sm" variant="primary" onClick={() => submit(value)}>
            Search
          </Button>
        </div>

        {search.result !== null ? (
          <QualifierChips query={search.result.query} channels={channels} users={users} meId={meId} />
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUALIFIER_HELP.map((qualifier) => (
              <button
                key={qualifier}
                type="button"
                onClick={() => {
                  const next = `${value} ${qualifier}`.trim();
                  setValue(next);
                  inputRef.current?.focus();
                }}
                className="cursor-pointer rounded-full border border-kumo-line px-2 py-0.5 font-mono text-[11px] text-kumo-subtle transition-colors hover:border-kumo-ring hover:text-kumo-default"
              >
                {qualifier}
              </button>
            ))}
          </div>
        )}
      </div>

      {search.running ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : search.error !== null ? (
        <EmptyState
          icon={<X size={20} />}
          title="That search could not be run"
          body={search.error}
          action={
            <Button variant="secondary" onClick={() => submit(value)}>
              Try again
            </Button>
          }
        />
      ) : search.result === null ? (
        <EmptyState
          icon={<MagnifyingGlass size={20} />}
          title="Search everything you can see"
          body="Plain words match message text. Qualifiers narrow it down; membership is always enforced, so results never include a conversation you are not in."
        />
      ) : hitCount === 0 && search.result.channels.length === 0 && search.result.users.length === 0 ? (
        <EmptyState
          icon={<MagnifyingGlass size={20} />}
          title="No matches"
          body="Try fewer words, or drop a qualifier."
        />
      ) : (
        <div className="pb-8">
          {(search.result.channels.length > 0 || search.result.users.length > 0) && (
            <section className="border-b border-kumo-line px-4 py-3">
              <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">
                Channels and people
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {search.result.channels.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => onOpenChannel(channel.id)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line px-2.5 py-1 text-[12px] text-kumo-default transition-colors hover:border-kumo-ring hover:bg-kumo-tint"
                  >
                    <Hash size={12} className="text-kumo-subtle" />
                    {channelLabel(channel, users, meId).replace(/^#/, "")}
                  </button>
                ))}
                {search.result.users.map((user) => (
                  <span
                    key={user.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-kumo-line px-2.5 py-1 text-[12px] text-kumo-default"
                  >
                    <Avatar name={user.name} id={user.id} size={16} />
                    {user.name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {grouped.map(([channelId, hits]) => {
            const channel = channels[channelId];
            return (
              <section key={channelId} className="border-b border-kumo-line last:border-b-0">
                <h2 className="sticky top-[104px] z-[1] flex items-center gap-2 bg-kumo-elevated px-4 py-1.5 text-[11px] font-semibold text-kumo-subtle">
                  {channel === undefined ? "Unknown" : channelLabel(channel, users, meId)}
                  <span className="font-normal text-kumo-inactive">
                    {hits.length} {hits.length === 1 ? "result" : "results"}
                  </span>
                </h2>
                <ul>
                  {hits.map((hit) => (
                    <li key={hit.message.id} className="group">
                      <div className="flex gap-3 px-4 py-3 transition-colors group-hover:bg-kumo-elevated">
                        <Avatar
                          name={users[hit.message.authorId]?.name ?? "?"}
                          id={hit.message.authorId}
                          size={28}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-baseline gap-2">
                            <span className="truncate text-[12px] font-semibold text-kumo-strong">
                              {users[hit.message.authorId]?.name ?? "Unknown"}
                            </span>
                            <span className="shrink-0 text-[11px] text-kumo-inactive">
                              {formatListTime(hit.message.createdAt)}
                            </span>
                            {hit.root !== null && (
                              <span className="truncate text-[11px] text-kumo-subtle">
                                in a thread
                              </span>
                            )}
                          </p>
                          <Snippet snippet={hit.snippet} />
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="self-start"
                          onClick={() => onJump(hit.channelId, hit.message.id)}
                        >
                          Jump
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </ViewShell>
  );
}

function QualifierChips({
  query,
  channels,
  users,
  meId,
}: {
  query: SearchQuery;
  channels: Readonly<Record<string, import("../contract.js").Channel>>;
  users: Readonly<Record<string, import("../contract.js").User>>;
  meId: string | undefined;
}): ReactNode {
  const chips: string[] = [];
  for (const id of query.in ?? []) {
    const channel = channels[id];
    chips.push(`in:${channel === undefined ? id : channelLabel(channel, users, meId)}`);
  }
  for (const id of query.from ?? []) chips.push(`from:@${users[id]?.name ?? id}`);
  for (const id of query.to ?? []) chips.push(`to:${id === meId ? "me" : (users[id]?.name ?? id)}`);
  for (const filter of query.has ?? []) chips.push(`has:${filter}`);
  if (query.isThread === true) chips.push("is:thread");
  if (query.before !== undefined) chips.push(`before:${new Date(query.before).toISOString().slice(0, 10)}`);
  if (query.after !== undefined) chips.push(`after:${new Date(query.after).toISOString().slice(0, 10)}`);
  if (chips.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-kumo-inactive">Interpreted as</span>
      {chips.map((chip) => (
        <span
          key={chip}
          className="rounded-full border border-kumo-brand/30 bg-kumo-brand/10 px-2 py-0.5 font-mono text-[11px] text-kumo-brand"
        >
          {chip}
        </span>
      ))}
      {query.text.length > 0 && (
        <span className="rounded-full border border-kumo-line px-2 py-0.5 text-[11px] text-kumo-subtle">
          “{query.text}”
        </span>
      )}
    </div>
  );
}
