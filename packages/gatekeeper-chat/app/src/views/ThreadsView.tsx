// Threads: the followed threads with unseen replies first, then the rest.

import { ChatsCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, type ReactNode } from "react";

import { channelLabel } from "../lib/labels.js";
import { formatRelative } from "../lib/format.js";
import { toPlainText } from "../lib/markdown.js";
import { mentionsToText } from "../lib/mentions.js";
import { useChat, useStore } from "../hooks/store.js";
import { Avatar, Button, CountBadge, EmptyState, Skeleton } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function ThreadsView({
  onOpen,
  onBack,
}: {
  onOpen: (channelId: string, rootId: string) => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const threads = useChat((state) => state.threads);
  const loading = useChat((state) => state.threadsLoading);
  const channels = useChat((state) => state.channels);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);

  useEffect(() => {
    void store.loadThreads();
  }, [store]);

  const ordered = useMemo(
    () =>
      [...threads].sort(
        (a, b) =>
          Number(b.unreadReplies > 0) - Number(a.unreadReplies > 0) ||
          (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0),
      ),
    [threads],
  );

  return (
    <ViewShell
      title="Threads"
      subtitle={`${threads.length} followed`}
      {...(onBack === undefined ? {} : { onBack })}
      actions={
        <Button size="sm" variant="secondary" onClick={() => void store.loadThreads()}>
          Refresh
        </Button>
      }
    >
      {loading && threads.length === 0 ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={<ChatsCircle size={20} />}
          title="No threads yet"
          body="You follow a thread when you start it, reply to it, or are mentioned in it."
        />
      ) : (
        <ul className="divide-y divide-kumo-line">
          {ordered.map((thread) => {
            const channel = channels[thread.channelId];
            const author = users[thread.root.authorId];
            return (
              <li key={thread.rootId}>
                <button
                  type="button"
                  onClick={() => onOpen(thread.channelId, thread.rootId)}
                  className="flex w-full cursor-pointer gap-3 px-4 py-3.5 text-left transition-colors hover:bg-kumo-elevated"
                >
                  <Avatar name={author?.name ?? "?"} id={thread.root.authorId} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-kumo-strong">
                        {author?.name ?? "Unknown"}
                      </span>
                      <span className="shrink-0 text-[11px] text-kumo-subtle">
                        {channel === undefined ? "" : channelLabel(channel, users, meId)}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-kumo-inactive">
                        {thread.lastReplyAt === null ? "" : formatRelative(thread.lastReplyAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-kumo-default">
                      {mentionsToText(
                        toPlainText(thread.root.body) || "(deleted)",
                        (id) => users[id]?.name,
                        (id) => channels[id]?.name ?? undefined,
                      )}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <span className="flex -space-x-1.5">
                        {thread.participantIds.slice(0, 4).map((id) => (
                          <Avatar key={id} name={users[id]?.name ?? "?"} id={id} size={18} />
                        ))}
                      </span>
                      <span className="text-[11px] font-medium text-kumo-link">
                        {thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`}
                      </span>
                      <CountBadge count={thread.unreadReplies} />
                    </span>
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
