// The channel details pane: About (topic and purpose, editable in place), Members, and Files.
//
// Files is the plan's "Files tab" for one conversation -- attachments only, newest first -- and is
// derived from the messages already loaded plus whatever history paging has brought in, which is enough
// until the server grows a dedicated route.

import { DownloadSimple, FileText, Hash, LockSimple, X } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";

import type { Attachment } from "../contract.js";
import { formatBytes, formatListTime } from "../lib/format.js";
import { fileUrl, isInlineImage } from "../lib/files.js";
import { channelLabel, isDirect, isGeneral } from "../lib/labels.js";
import { useChat, useStore } from "../hooks/store.js";
import { conversationKey } from "../store/drafts.js";
import { isAgent } from "../lib/agent.js";
import { AppBadge, Avatar, Button, EmptyState, IconButton } from "./primitives.js";

type Tab = "about" | "members" | "files";

export function ChannelDetails({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}): ReactNode {
  const store = useStore();
  const channel = useChat((state) => state.channels[channelId]);
  const membership = useChat((state) => state.memberships[channelId]);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const admin = useChat((state) => state.admin);
  const messages = useChat((state) => state.conversations[conversationKey(channelId)]?.messages);
  const [tab, setTab] = useState<Tab>("about");
  const [topic, setTopic] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<string | null>(null);

  const files = useMemo(() => {
    const out: Array<{ attachment: Attachment; at: number; authorId: string }> = [];
    for (const message of messages ?? []) {
      for (const attachment of message.attachments) {
        out.push({ attachment, at: message.createdAt, authorId: message.authorId });
      }
    }
    return out.toSorted((a, b) => b.at - a.at);
  }, [messages]);

  if (channel === undefined) return null;
  const label = channelLabel(channel, users, meId);
  const memberIds = channel.memberIds ?? [];
  const canEdit = !isDirect(channel) && (admin || membership !== undefined);

  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full min-w-0 flex-col border-l border-kumo-line bg-kumo-base"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line px-4">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {channel.kind === "private" ? (
            <LockSimple size={15} className="text-kumo-subtle" />
          ) : !isDirect(channel) ? (
            <Hash size={15} className="text-kumo-subtle" />
          ) : null}
          <h2 className="truncate text-[14px] font-semibold text-kumo-strong">{label}</h2>
        </span>
        <IconButton label="Close details" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="flex shrink-0 gap-1 border-b border-kumo-line px-3">
        {(["about", "members", "files"] as Tab[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => setTab(candidate)}
            aria-current={tab === candidate ? "true" : undefined}
            className={[
              "-mb-px cursor-pointer border-b-2 px-2.5 py-2.5 text-[12px] font-medium capitalize transition-colors",
              tab === candidate
                ? "border-kumo-brand text-kumo-brand"
                : "border-transparent text-kumo-subtle hover:text-kumo-default",
            ].join(" ")}
          >
            {candidate}
            {candidate === "members" && ` (${channel.memberCount})`}
            {candidate === "files" && files.length > 0 && ` (${files.length})`}
          </button>
        ))}
      </div>

      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "about" && (
          <div className="flex flex-col gap-5">
            <Field
              label="Topic"
              value={channel.topic}
              placeholder="Add a topic"
              editable={canEdit}
              draft={topic}
              onDraft={setTopic}
              onSave={(next) => void store.updateChannel(channelId, { topic: next })}
            />
            <Field
              label="Purpose"
              value={channel.purpose}
              placeholder="Add a purpose"
              editable={canEdit}
              multiline
              draft={purpose}
              onDraft={setPurpose}
              onSave={(next) => void store.updateChannel(channelId, { purpose: next })}
            />
            <dl className="space-y-2 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-kumo-subtle">Created</dt>
                <dd className="text-kumo-default">{formatListTime(channel.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-kumo-subtle">Created by</dt>
                <dd className="text-kumo-default">{users[channel.createdBy]?.name ?? "Unknown"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-kumo-subtle">Visibility</dt>
                <dd className="text-kumo-default capitalize">{channel.kind}</dd>
              </div>
            </dl>

            {!isDirect(channel) && (
              <div className="flex flex-col gap-2 border-t border-kumo-line pt-4">
                {membership === undefined ? (
                  <Button variant="primary" onClick={() => void store.joinChannel(channelId)}>
                    Join {label}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={isGeneral(channel)}
                    title={isGeneral(channel) ? "#general cannot be left." : undefined}
                    onClick={() => void store.leaveChannel(channelId)}
                  >
                    Leave {label}
                  </Button>
                )}
                {admin && !channel.archived && (
                  <Button variant="danger" onClick={() => void store.archiveChannel(channelId)}>
                    Archive channel
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "members" && (
          <ul className="flex flex-col gap-1">
            {(memberIds.length > 0 ? memberIds : Object.keys(users).slice(0, channel.memberCount)).map(
              (id) => {
                const user = users[id];
                if (user === undefined) return null;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => void store.openDm(id)}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-kumo-tint"
                    >
                      <Avatar
                        name={user.name}
                        id={user.id}
                        size={28}
                        online={user.online}
                        kind={isAgent(user) ? "agent" : "user"}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 truncate text-[13px] text-kumo-default">
                          {user.name}
                          {user.id === meId && <span className="text-kumo-inactive"> (you)</span>}
                          {isAgent(user) && <AppBadge />}
                        </span>
                        <span className="block truncate text-[11px] text-kumo-inactive">
                          {user.email ?? ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              },
            )}
          </ul>
        )}

        {tab === "files" &&
          (files.length === 0 ? (
            <EmptyState
              icon={<FileText size={18} />}
              title="No files yet"
              body="Images and files shared in this conversation appear here."
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {files.map(({ attachment, at, authorId }) => (
                <li key={attachment.id}>
                  <a
                    href={fileUrl(attachment.id)}
                    download={attachment.name}
                    className="group flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-elevated p-2 transition-colors hover:border-kumo-ring"
                  >
                    {isInlineImage(attachment.mime) ? (
                      <img
                        src={fileUrl(attachment.id, attachment.hasThumb)}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-kumo-fill text-kumo-subtle">
                        <FileText size={16} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-kumo-strong">
                        {attachment.name}
                      </span>
                      <span className="block truncate text-[11px] text-kumo-subtle">
                        {users[authorId]?.name ?? "Unknown"} · {formatBytes(attachment.bytes)} ·{" "}
                        {formatListTime(at)}
                      </span>
                    </span>
                    <DownloadSimple
                      size={15}
                      className="shrink-0 text-kumo-inactive group-hover:text-kumo-brand"
                    />
                  </a>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </aside>
  );
}

function Field({
  label,
  value,
  placeholder,
  editable,
  multiline = false,
  draft,
  onDraft,
  onSave,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  editable: boolean;
  multiline?: boolean;
  draft: string | null;
  onDraft: (value: string | null) => void;
  onSave: (value: string | null) => void;
}): ReactNode {
  const editing = draft !== null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">
          {label}
        </span>
        {editable && !editing && (
          <button
            type="button"
            onClick={() => onDraft(value ?? "")}
            className="cursor-pointer text-[11px] font-medium text-kumo-link hover:underline"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          {multiline ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              rows={3}
              aria-label={label}
              className="w-full resize-none rounded-lg border border-kumo-ring bg-kumo-control px-2.5 py-2 text-[13px] text-kumo-default outline-none focus:border-kumo-brand"
            />
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              aria-label={label}
              className="w-full rounded-lg border border-kumo-ring bg-kumo-control px-2.5 py-1.5 text-[13px] text-kumo-default outline-none focus:border-kumo-brand"
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => onDraft(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onSave(draft.trim().length === 0 ? null : draft.trim());
                onDraft(null);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className={`text-[13px] leading-5 ${value === null ? "text-kumo-inactive" : "text-kumo-default"}`}>
          {value ?? placeholder}
        </p>
      )}
    </div>
  );
}
