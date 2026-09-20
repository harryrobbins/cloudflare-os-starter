// Drafts: every conversation with unsent text, newest first.

import { NotePencil, Trash } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";

import { channelLabel } from "../lib/labels.js";
import { formatRelative } from "../lib/format.js";
import { toPlainText } from "../lib/markdown.js";
import { mentionsToText } from "../lib/mentions.js";
import { useChat, useStore } from "../hooks/store.js";
import { parseConversationKey } from "../store/drafts.js";
import { EmptyState, IconButton } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function DraftsView({
  onOpen,
  onBack,
}: {
  onOpen: (channelId: string, rootId: string | null) => void;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const drafts = useChat((state) => state.drafts);
  const channels = useChat((state) => state.channels);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);

  const entries = useMemo(
    () =>
      Object.entries(drafts)
        .map(([key, draft]) => ({ key, draft, ...parseConversationKey(key) }))
        .sort((a, b) => b.draft.updatedAt - a.draft.updatedAt),
    [drafts],
  );

  return (
    <ViewShell
      title="Drafts"
      subtitle={`${entries.length} unsent`}
      {...(onBack === undefined ? {} : { onBack })}
    >
      {entries.length === 0 ? (
        <EmptyState
          icon={<NotePencil size={20} />}
          title="No drafts"
          body="Anything you type and do not send is kept here, per conversation."
        />
      ) : (
        <ul className="divide-y divide-kumo-line">
          {entries.map((entry) => {
            const channel = channels[entry.channelId];
            return (
              <li key={entry.key} className="group flex items-start gap-2 pr-3">
                <button
                  type="button"
                  onClick={() => onOpen(entry.channelId, entry.rootId)}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 px-4 py-3.5 text-left transition-colors group-hover:bg-kumo-elevated"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-semibold text-kumo-strong">
                      {channel === undefined ? "Unknown conversation" : channelLabel(channel, users, meId)}
                    </span>
                    {entry.rootId !== null && (
                      <span className="shrink-0 rounded bg-kumo-fill px-1.5 py-px text-[10px] font-medium text-kumo-subtle">
                        thread
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-kumo-inactive">
                      {formatRelative(entry.draft.updatedAt)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[13px] leading-5 text-kumo-subtle">
                    {mentionsToText(
                      toPlainText(entry.draft.body),
                      (id) => users[id]?.name,
                      (id) => channels[id]?.name ?? undefined,
                    )}
                  </span>
                </button>
                <IconButton
                  label="Discard draft"
                  tone="danger"
                  className="mt-3.5"
                  onClick={() => store.discardDraft(entry.key)}
                >
                  <Trash size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </ViewShell>
  );
}
