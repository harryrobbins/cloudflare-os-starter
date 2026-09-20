// Mentions & reactions.
//
// CONTRACT GAP: there is no `GET /api/mentions`. The nearest thing the contract does offer is the
// search qualifier `to:me`, which the server resolves to the caller's id, so this view runs that query
// and groups the result. It is a genuine fallback rather than a placeholder: the results are the same
// messages, ordered newest first, with the same Jump affordance.

import { At } from "@phosphor-icons/react";
import { useEffect, type ReactNode } from "react";

import { channelLabel } from "../lib/labels.js";
import { formatListTime } from "../lib/format.js";
import { useChat, useStore } from "../hooks/store.js";
import { Markdown } from "../components/Markdown.js";
import { Avatar, EmptyState, Skeleton } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

const MENTIONS_QUERY = "to:me";

export function MentionsView({
  onJump,
  onBack,
}: {
  onJump: (channelId: string, messageId: string) => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const search = useChat((state) => state.search);
  const channels = useChat((state) => state.channels);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);

  useEffect(() => {
    void store.runSearch(MENTIONS_QUERY);
  }, [store]);

  const hits = search.query === MENTIONS_QUERY ? (search.result?.hits ?? []) : [];

  return (
    <ViewShell
      title="Mentions & reactions"
      subtitle="Everything addressed to you"
      {...(onBack === undefined ? {} : { onBack })}
    >
      {search.running ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<At size={20} />}
          title="No mentions yet"
          body="When somebody types your name from the @ menu, the message lands here."
        />
      ) : (
        <ul className="divide-y divide-kumo-line">
          {hits.map((hit) => {
            const channel = channels[hit.channelId];
            const author = users[hit.message.authorId];
            return (
              <li key={hit.message.id}>
                <button
                  type="button"
                  onClick={() => onJump(hit.channelId, hit.message.id)}
                  className="flex w-full cursor-pointer gap-3 px-4 py-3.5 text-left transition-colors hover:bg-kumo-elevated"
                >
                  <Avatar name={author?.name ?? "?"} id={hit.message.authorId} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-semibold text-kumo-strong">
                        {author?.name ?? "Unknown"}
                      </span>
                      <span className="shrink-0 text-[11px] text-kumo-subtle">
                        {channel === undefined ? "" : channelLabel(channel, users, meId)}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-kumo-inactive">
                        {formatListTime(hit.message.createdAt)}
                      </span>
                    </span>
                    <Markdown body={hit.message.body} className="mt-0.5" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ViewShell>
  );
}
