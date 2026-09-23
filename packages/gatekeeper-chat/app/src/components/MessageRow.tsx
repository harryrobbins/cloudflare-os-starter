// One message.
//
// The row owns its hover/focus action bar, its inline editor and its reactions. It is deliberately a
// single component rather than a stack of small ones: every one of those pieces needs the same three
// facts (is it mine, is it a tombstone, is it still pending), and threading them through four layers of
// props was worse than one file with sections.
//
// Accessibility: the action bar appears on hover *and* on keyboard focus anywhere in the row, and every
// action is a real button, so the plan's "keyboard equivalents for hover actions" needs no shortcut
// table. The row itself is a listitem with `tabIndex` managed by the list's roving focus.

import {
  ArrowBendUpLeft,
  DotsThree,
  Link as LinkIcon,
  PencilSimple,
  SmileySticker,
  Trash,
  EnvelopeSimpleOpen,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { Message } from "../contract.js";
import { formatTime } from "../lib/format.js";
import { mentionsToText } from "../lib/mentions.js";
import {
  describeReactors,
  quickReactions,
  subscribeQuickReactions,
} from "../lib/reactions.js";
import { useChat, useStore } from "../hooks/store.js";
import { describeSeen, type SeenReader } from "../lib/seen.js";
import type { LocalMessage } from "../store/merge.js";
import { AgentReplyFooter, AgentRequestStatus } from "./AgentStatus.js";
import { Attachments } from "./Attachments.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { Markdown } from "./Markdown.js";
import { AppBadge, Avatar, IconButton } from "./primitives.js";

export interface MessageRowProps {
  readonly message: LocalMessage;
  readonly startsGroup: boolean;
  /** Highlights the row after a permalink jump. */
  readonly focused: boolean;
  readonly canThread: boolean;
  readonly onOpenThread: (rootId: string) => void;
  readonly onCopyLink: (message: Message) => void;
  readonly onMarkUnread: (message: Message) => void;
  readonly onMentionClick: (kind: "user" | "channel", id: string) => void;
  readonly onRetry: (clientId: string) => void;
  readonly onDiscard: (clientId: string) => void;
  /** The people whose read cursor sits on this message. Undefined everywhere it does not apply. */
  readonly seenBy?: readonly SeenReader[];
}

export const MessageRow = memo(function MessageRow({
  message,
  startsGroup,
  focused,
  canThread,
  onOpenThread,
  onCopyLink,
  onMarkUnread,
  onMentionClick,
  onRetry,
  onDiscard,
  seenBy,
}: MessageRowProps): ReactNode {
  const store = useStore();
  /**
   * The quick-pick row, which is the reader's own habit rather than a fixed list.
   *
   * `useSyncExternalStore` over the module in `lib/reactions.ts`, so reacting in one row updates the
   * bar in every other one without the store or a context knowing anything about emoji.
   */
  const quickPicks = useSyncExternalStore(subscribeQuickReactions, quickReactions, quickReactions);
  const author = useChat((state) => state.users[message.authorId]);
  const meId = useChat((state) => state.me?.id);
  const users = useChat((state) => state.users);
  const channels = useChat((state) => state.channels);
  /** The editor works in display text (`@Alice Chen`), which `store.editMessage` resolves back. */
  const displayBody = useMemo(
    () =>
      mentionsToText(
        message.body,
        (id) => users[id]?.name,
        (id) => channels[id]?.name ?? undefined,
      ),
    [message.body, users, channels],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayBody);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const mine = message.authorId === meId;
  const tombstone = message.deletedAt !== null;
  const pending = message.local?.state === "pending";
  const failed = message.local?.state === "failed";
  const system = message.kind === "system";

  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [focused]);

  // A system message is a one-line note, not a conversation turn.
  if (system) {
    return (
      <div
        role="listitem"
        className="flex items-center gap-2 px-5 py-1 text-[12px] text-kumo-subtle"
      >
        <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
        <span className="shrink-0">{message.body}</span>
        <time dateTime={new Date(message.createdAt).toISOString()} className="shrink-0 tabular-nums">
          {formatTime(message.createdAt)}
        </time>
        <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
      </div>
    );
  }

  function submitEdit(): void {
    const next = draft.trim();
    setEditing(false);
    if (next.length === 0 || next === displayBody) return;
    void store.editMessage(message.id, next);
  }

  function onEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      setDraft(displayBody);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitEdit();
    }
  }

  return (
    <div
      ref={rowRef}
      role="listitem"
      // Focusable only programmatically: the list owns a roving focus so Tab does not walk through a
      // thousand rows, while ArrowUp/ArrowDown move between them.
      tabIndex={-1}
      data-message-id={message.id}
      className={[
        "group relative px-5 transition-colors",
        startsGroup ? "mt-3 pt-0.5" : "",
        focused ? "chat-flash" : "",
        // Only an uncommitted row animates in. Once the server answers, the row is re-keyed under its
        // real id and remounts -- so a class that did not depend on `local` would play the entrance a
        // second time, which reads as a glitch rather than as delivery.
        message.local === undefined ? "" : "chat-rise",
        "hover:bg-kumo-elevated focus-within:bg-kumo-elevated focus-visible:outline-none focus-visible:bg-kumo-elevated",
      ].join(" ")}
    >
      <div className="flex gap-3">
        {/* Gutter: the avatar on a group's first row, the timestamp on hover otherwise. */}
        <div className="w-9 shrink-0 pt-0.5">
          {startsGroup ? (
            <Avatar
              name={author?.name ?? "Unknown"}
              id={message.authorId}
              size={36}
              kind={message.kind === "agent" ? "agent" : "user"}
            />
          ) : (
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              className={[
                "mt-0.5 block text-right text-[10px] leading-5 text-kumo-inactive tabular-nums transition-opacity",
                // A pending row shows its time faintly rather than on hover: that half-there
                // timestamp *is* the pending state, which is why there is no spinner.
                pending ? "opacity-40" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              ].join(" ")}
            >
              {formatTime(message.createdAt)}
            </time>
          )}
        </div>

        <div className="min-w-0 flex-1 pb-0.5">
          {startsGroup && (
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold text-kumo-strong">
                {author?.name ?? "Unknown"}
              </span>
              {message.kind === "agent" && <AppBadge />}
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                title={pending ? "Sending" : undefined}
                className={`text-[11px] text-kumo-inactive tabular-nums ${pending ? "opacity-40" : ""}`}
              >
                {formatTime(message.createdAt)}
              </time>
            </div>
          )}

          {tombstone ? (
            <p className="text-[13px] text-kumo-inactive italic">This message was deleted.</p>
          ) : editing ? (
            <div className="mt-1 rounded-lg border border-kumo-brand bg-kumo-control p-2">
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onEditKeyDown}
                rows={Math.min(10, draft.split("\n").length + 1)}
                aria-label="Edit message"
                className="w-full resize-none bg-transparent text-[13px] leading-5 text-kumo-default outline-none"
              />
              <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-kumo-subtle">
                <span className="mr-auto">Enter to save, Escape to cancel</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(displayBody);
                  }}
                  className="cursor-pointer rounded px-2 py-1 hover:bg-kumo-tint"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitEdit}
                  className="cursor-pointer rounded bg-kumo-brand px-2 py-1 font-medium text-white hover:bg-kumo-brand-hover"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <Markdown
                body={message.body}
                onMentionClick={onMentionClick}
                className={message.editedAt === null ? "" : "md-inline-tail"}
              />
              {message.editedAt !== null && (
                <span
                  className="ml-1 align-baseline text-[11px] text-kumo-inactive"
                  title={`Edited ${new Date(message.editedAt).toLocaleString("en-GB")}`}
                >
                  (edited)
                </span>
              )}
            </>
          )}

          <Attachments attachments={message.attachments} />

          {message.reactions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {message.reactions.map((reaction) => (
                <ReactionPill
                  key={reaction.emoji}
                  emoji={reaction.emoji}
                  userIds={reaction.userIds}
                  meId={meId}
                  nameOf={(id) => users[id]?.name}
                  onToggle={() => void store.toggleReaction(message, reaction.emoji)}
                />
              ))}
              <IconButton label="Add a reaction" onClick={() => setPickerOpen(true)} className="h-6 w-6">
                <SmileySticker size={14} />
              </IconButton>
            </div>
          )}

          {message.rootId === null && message.replyCount > 0 && (
            <button
              type="button"
              onClick={() => onOpenThread(message.id)}
              className="press mt-1.5 inline-flex cursor-pointer items-center gap-2 rounded-md py-1 pr-2 text-[12px] font-medium text-kumo-link hover:underline"
            >
              <ArrowBendUpLeft size={13} />
              {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
              {message.lastReplyAt !== null && (
                <span className="font-normal text-kumo-subtle">
                  last reply {formatTime(message.lastReplyAt)}
                </span>
              )}
            </button>
          )}

          {/* One quiet line rather than an alert box: the message is still on screen and still
              readable, and the two things worth doing about it are right there. The reason lives in
              the tooltip, because "fetch failed" in the transcript is noise. */}
          {failed && (
            <div
              className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-kumo-danger"
              title={message.local?.error}
            >
              <WarningCircle size={12} weight="fill" aria-hidden="true" />
              <span className="font-medium">Not sent</span>
              <span aria-hidden="true" className="text-kumo-inactive">·</span>
              <button
                type="button"
                onClick={() => message.clientId !== undefined && onRetry(message.clientId)}
                className="cursor-pointer font-semibold underline underline-offset-2 hover:no-underline"
              >
                Retry
              </button>
              <span aria-hidden="true" className="text-kumo-inactive">·</span>
              <button
                type="button"
                onClick={() => message.clientId !== undefined && onDiscard(message.clientId)}
                className="cursor-pointer underline underline-offset-2 hover:no-underline"
              >
                Discard
              </button>
            </div>
          )}
          {!tombstone && (
            <AgentRequestStatus
              message={message}
              meId={meId}
              onRetry={() => void store.retryAgent(message.id)}
            />
          )}
          {!tombstone && <AgentReplyFooter message={message} meId={meId} />}
          {seenBy !== undefined && seenBy.length > 0 && (
            <SeenStack readers={seenBy} nameOf={(id) => users[id]?.name} />
          )}
        </div>
      </div>

      {/* Action bar. Absolutely positioned so it never changes the row's height. */}
      {!tombstone && !editing && !pending && (
        <div className="pointer-events-none absolute -top-3 right-4 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-kumo-line bg-kumo-control p-0.5 shadow-sm">
            {quickPicks.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => void store.toggleReaction(message, emoji)}
                aria-label={`React with ${emoji}`}
                title={`React with ${emoji}`}
                className="press flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[15px] hover:bg-kumo-tint"
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
            <IconButton label="Add a reaction" onClick={() => setPickerOpen(true)}>
              <SmileySticker size={15} />
            </IconButton>
            {canThread && (
              <IconButton label="Reply in thread" onClick={() => onOpenThread(message.rootId ?? message.id)}>
                <ArrowBendUpLeft size={15} />
              </IconButton>
            )}
            <IconButton label="Copy link" onClick={() => onCopyLink(message)}>
              <LinkIcon size={15} />
            </IconButton>
            {mine && (
              <IconButton
                label="Edit message"
                onClick={() => {
                  setDraft(displayBody);
                  setEditing(true);
                }}
              >
                <PencilSimple size={15} />
              </IconButton>
            )}
            <div className="relative">
              <IconButton label="More actions" onClick={() => setMenuOpen((open) => !open)} active={menuOpen}>
                <DotsThree size={16} weight="bold" />
              </IconButton>
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    aria-hidden="true"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className="absolute top-8 right-0 z-20 w-52 overflow-hidden rounded-lg border border-kumo-line bg-kumo-control py-1 shadow-lg"
                  >
                    <MenuItem
                      icon={<EnvelopeSimpleOpen size={14} />}
                      label="Mark unread from here"
                      onClick={() => {
                        setMenuOpen(false);
                        onMarkUnread(message);
                      }}
                    />
                    <MenuItem
                      icon={<LinkIcon size={14} />}
                      label="Copy link to message"
                      onClick={() => {
                        setMenuOpen(false);
                        onCopyLink(message);
                      }}
                    />
                    {mine && (
                      <MenuItem
                        icon={<Trash size={14} />}
                        label="Delete message"
                        tone="danger"
                        onClick={() => {
                          setMenuOpen(false);
                          void store.deleteMessage(message.id);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <EmojiPicker
          onPick={(emoji) => {
            setPickerOpen(false);
            void store.toggleReaction(message, emoji);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
});

/**
 * The read markers for one message.
 *
 * Monograms rather than a sentence, because the useful fact is *where* people have got to, and a line
 * of prose at the bottom of the pane cannot say that. They overlap by a few pixels so four readers
 * take the space of two, and the sentence survives as the label for anybody who cannot see the stack.
 */
function SeenStack({
  readers,
  nameOf,
}: {
  readers: readonly SeenReader[];
  nameOf: (id: string) => string | undefined;
}): ReactNode {
  const label = describeSeen(readers, nameOf);
  const shown = readers.slice(0, 4);
  return (
    <div
      data-testid="seen-by"
      aria-label={label}
      title={label}
      className="mt-1 flex items-center justify-end gap-1"
    >
      <span className="flex -space-x-1.5">
        {shown.map((reader) => (
          <span key={reader.userId} className="rounded-[28%] ring-2 ring-kumo-base">
            <Avatar name={nameOf(reader.userId) ?? "?"} id={reader.userId} size={16} />
          </span>
        ))}
      </span>
      {readers.length > shown.length && (
        <span className="text-[10px] text-kumo-inactive tabular-nums">
          +{readers.length - shown.length}
        </span>
      )}
    </div>
  );
}

/**
 * One reaction pill.
 *
 * Its own component for one reason: the pop belongs to a *count change*, which needs a previous value
 * to compare against, and that is state the row itself must not carry once per emoji. The animation
 * fires for a remote reaction as well as your own -- a channel where reactions land silently feels
 * dead -- and the stylesheet turns it off under `prefers-reduced-motion`.
 */
function ReactionPill({
  emoji,
  userIds,
  meId,
  nameOf,
  onToggle,
}: {
  emoji: string;
  userIds: readonly string[];
  meId: string | undefined;
  nameOf: (id: string) => string | undefined;
  onToggle: () => void;
}): ReactNode {
  const reacted = meId !== undefined && userIds.includes(meId);
  const [popping, setPopping] = useState(false);
  const previousCount = useRef(userIds.length);

  useEffect(() => {
    if (userIds.length === previousCount.current) return;
    previousCount.current = userIds.length;
    setPopping(true);
    const timer = setTimeout(() => setPopping(false), 260);
    return () => clearTimeout(timer);
  }, [userIds.length]);

  const who = describeReactors(emoji, userIds, meId, nameOf);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={reacted}
      // The sentence is the label as well as the tooltip: "👍, 3" tells a screen-reader user the
      // count and nothing about who, which is the half that matters.
      aria-label={who}
      title={who}
      className={[
        "press inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-[12px] transition-colors",
        popping ? "chat-pop" : "",
        reacted
          ? "border-kumo-brand bg-kumo-brand/12 text-kumo-brand"
          : "border-kumo-line bg-kumo-elevated text-kumo-subtle hover:border-kumo-ring",
      ].join(" ")}
    >
      <span aria-hidden="true">{emoji}</span>
      <span className="tabular-nums">{userIds.length}</span>
    </button>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors",
        tone === "danger"
          ? "text-kumo-danger hover:bg-kumo-danger-tint"
          : "text-kumo-default hover:bg-kumo-tint",
      ].join(" ")}
    >
      <span className="text-kumo-subtle">{icon}</span>
      {label}
    </button>
  );
}
