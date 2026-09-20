// A channel: header, message list, typing line, composer.
//
// The same component serves a permalink (`focusMessageId` centres and flashes the row) and an ordinary
// open. It is also what the narrow layout shows on its own, so it carries the back affordance rather
// than the shell.

import {
  BellSlash,
  CaretDown,
  Hash,
  Info,
  List,
  LockSimple,
  Star,
  Users,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Message, NotifyLevel } from "../contract.js";
import { channelLabel, isDirect } from "../lib/labels.js";
import { permalinkUrl } from "../lib/nav.js";
import { pluralise } from "../lib/format.js";
import { useChat, useStore } from "../hooks/store.js";
import { conversationKey } from "../store/drafts.js";
import { EMPTY_CONVERSATION } from "../store/state.js";
import { firstUnreadSeq } from "../store/unread.js";
import { Composer } from "./Composer.js";
import { MessageList } from "./MessageList.js";
import { Button, EmptyState, IconButton, PresenceDot } from "./primitives.js";

export function ConversationView({
  channelId,
  focusMessageId = null,
  onOpenThread,
  onToggleDetails,
  onBack,
  detailsOpen,
}: {
  channelId: string;
  focusMessageId?: string | null;
  onOpenThread: (rootId: string) => void;
  onToggleDetails: () => void;
  onBack?: () => void;
  detailsOpen: boolean;
}): ReactNode {
  const store = useStore();
  const channel = useChat((state) => state.channels[channelId]);
  const membership = useChat((state) => state.memberships[channelId]);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const conversation = useChat(
    (state) => state.conversations[conversationKey(channelId)] ?? EMPTY_CONVERSATION,
  );
  const typing = useChat((state) => state.typing[channelId]);
  const online = useChat((state) => state.online);
  const readCursors = useChat((state) => state.readCursors[channelId]);

  const label = channel === undefined ? "" : channelLabel(channel, users, meId);

  /**
   * Where the "New messages" rule goes, frozen for as long as this conversation stays open.
   *
   * Reading straight from the membership would be wrong in the one case that matters: opening an unread
   * channel marks it read within a few hundred milliseconds, so the rule would appear and vanish before
   * it was any use. It is captured when the conversation opens and kept until you leave, which is what
   * "scrolling up keeps the New messages line" means. A message arriving while you are scrolled away
   * still introduces one, because the live value is adopted whenever there is no rule yet.
   */
  const liveUnread = useMemo(
    () => firstUnreadSeq(membership, channel?.lastSeq ?? 0),
    [membership, channel?.lastSeq],
  );
  const frozenUnread = useRef<{ channelId: string; seq: number | null }>({ channelId, seq: liveUnread });
  if (frozenUnread.current.channelId !== channelId) {
    frozenUnread.current = { channelId, seq: liveUnread };
  } else if (frozenUnread.current.seq === null && liveUnread !== null) {
    frozenUnread.current = { channelId, seq: liveUnread };
  }
  const unreadFrom = frozenUnread.current.seq;

  useEffect(() => {
    store.setActive(channelId, null);
    void store.openConversation(channelId, focusMessageId === null ? {} : { around: focusMessageId });
  }, [store, channelId, focusMessageId]);

  const onCopyLink = useCallback(
    (message: Message) => {
      const url = permalinkUrl(message.channelId, message.id);
      void navigator.clipboard
        ?.writeText(url)
        .then(() => store.toast({ tone: "success", title: "Link copied" }))
        .catch(() =>
          store.toast({ tone: "error", title: "Could not copy the link", body: url, timeout: 8000 }),
        );
    },
    [store],
  );

  const onMentionClick = useCallback(
    (kind: "user" | "channel", id: string) => {
      if (kind === "channel") {
        store.setActive(id, null);
        return;
      }
      void store.openDm(id);
    },
    [store],
  );

  /**
   * "Seen by" for a direct or group conversation.
   *
   * `readCursors` is only sent for those two kinds, so an undefined entry means the affordance does not
   * apply here rather than "nobody has read". The yardstick is the newest message that actually exists
   * on the server: a pending local row has no `seq` yet, so nobody can have seen it.
   */
  const seenLine = useMemo(() => {
    if (readCursors === undefined || readCursors.length === 0) return null;
    const newest = conversation.messages.reduce<number>(
      (max, message) => (message.local === undefined && message.seq > max ? message.seq : max),
      0,
    );
    if (newest === 0) return null;
    const names = readCursors
      .filter((cursor) => cursor.userId !== meId && cursor.lastReadSeq >= newest)
      .map((cursor) => users[cursor.userId]?.name ?? "Someone");
    if (names.length === 0) return null;
    if (names.length === 1) return `Seen by ${names[0]}`;
    if (names.length === 2) return `Seen by ${names[0]} and ${names[1]}`;
    return `Seen by ${names.length} people`;
  }, [readCursors, conversation.messages, meId, users]);

  if (channel === undefined) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState
          icon={<Hash size={20} />}
          title="That conversation is not available"
          body="It may have been archived, or you may not be a member."
        />
      </div>
    );
  }

  const typingNames = Object.keys(typing ?? {})
    .filter((id) => id !== meId)
    .map((id) => users[id]?.name ?? "Someone");

  return (
    <div className="flex h-full min-w-0 flex-col bg-kumo-base">
      <Header
        channelId={channelId}
        label={label}
        onToggleDetails={onToggleDetails}
        detailsOpen={detailsOpen}
        {...(onBack === undefined ? {} : { onBack })}
      />

      {membership === undefined ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            icon={<Hash size={20} />}
            title={`You are not in ${label}`}
            body="Join to read the history and post."
            action={
              <Button variant="primary" onClick={() => void store.joinChannel(channelId)}>
                Join {label}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <MessageList
            key={channelId}
            messages={conversation.messages.filter((message) => message.rootId === null)}
            meId={meId}
            firstUnreadSeq={unreadFrom}
            loading={conversation.loading}
            loadingOlder={conversation.loadingOlder}
            hasMoreBefore={conversation.hasMoreBefore}
            focusMessageId={focusMessageId ?? conversation.focusMessageId}
            canThread
            showStart
            emptyState={
              <EmptyState
                icon={isDirect(channel) ? <Users size={20} /> : <Hash size={20} />}
                title={`This is the start of ${label}`}
                body={
                  channel.purpose ??
                  "Say something to get the conversation going. Messages here are visible to every member."
                }
              />
            }
            onLoadOlder={() => void store.loadOlder(channelId)}
            onAtBottomChange={(atBottom) => store.setAtBottom(channelId, null, atBottom)}
            onOpenThread={onOpenThread}
            onCopyLink={onCopyLink}
            onMarkUnread={(message) => void store.markUnreadFrom(channelId, message.seq)}
            onMentionClick={onMentionClick}
            onRetry={(clientId) => void store.retrySend(channelId, conversationKey(channelId), clientId)}
            onDiscard={(clientId) => store.discardSend(conversationKey(channelId), clientId)}
            onFocusHandled={() => store.clearFocusMessage(channelId)}
          />

          <div
            aria-live="polite"
            className="h-5 shrink-0 truncate px-5 text-[11px] text-kumo-subtle"
          >
            {typingNames.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex gap-0.5" aria-hidden="true">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="chat-typing-dot inline-block h-1 w-1 rounded-full bg-kumo-subtle"
                      style={{ animationDelay: `${dot * 0.15}s` }}
                    />
                  ))}
                </span>
                {typingNames.length === 1
                  ? `${typingNames[0]} is typing…`
                  : `${typingNames.slice(0, 2).join(" and ")} are typing…`}
              </span>
            )}
            {typingNames.length === 0 && seenLine !== null && (
              <span data-testid="seen-by">{seenLine}</span>
            )}
          </div>

          {channel.archived ? (
            <div className="mx-4 mb-4 rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-3 text-[12px] text-kumo-subtle">
              This channel is archived. You can read it, but not post.
            </div>
          ) : (
            <Composer
              channelId={channelId}
              conversationKey={conversationKey(channelId)}
              placeholder={`Message ${label}`}
            />
          )}
        </>
      )}

      {/* Presence of the other person in a DM, announced quietly under the header. */}
      {channel.kind === "dm" && (
        <span className="sr-only" aria-live="polite">
          {online.includes(channel.memberIds?.find((id) => id !== meId) ?? "")
            ? `${label} is online`
            : `${label} is offline`}
        </span>
      )}
    </div>
  );
}

function Header({
  channelId,
  label,
  onToggleDetails,
  detailsOpen,
  onBack,
}: {
  channelId: string;
  label: string;
  onToggleDetails: () => void;
  detailsOpen: boolean;
  onBack?: () => void;
}): ReactNode {
  const store = useStore();
  const channel = useChat((state) => state.channels[channelId]);
  const membership = useChat((state) => state.memberships[channelId]);
  const [notifyOpen, setNotifyOpen] = useState(false);
  if (channel === undefined) return null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line px-3 md:px-4">
      {onBack !== undefined && (
        <IconButton label="Conversations" onClick={onBack}>
          <List size={16} />
        </IconButton>
      )}
      <span className="flex min-w-0 items-center gap-2">
        {channel.kind === "private" ? (
          <LockSimple size={15} className="shrink-0 text-kumo-subtle" />
        ) : isDirect(channel) ? (
          <PresenceDot online={false} className="hidden" />
        ) : (
          <Hash size={15} className="shrink-0 text-kumo-subtle" />
        )}
        <h1 className="truncate text-[15px] font-semibold text-kumo-strong">{label}</h1>
        {membership !== undefined && (
          <IconButton
            label={membership.starred ? "Remove star" : "Star this conversation"}
            onClick={() => void store.toggleStar(channelId)}
            active={membership.starred}
          >
            <Star size={14} weight={membership.starred ? "fill" : "regular"} />
          </IconButton>
        )}
        {membership?.muted === true && (
          <BellSlash size={13} className="shrink-0 text-kumo-inactive" aria-label="Muted" />
        )}
      </span>

      {channel.topic !== null && (
        <>
          <span className="hidden h-4 w-px bg-kumo-line lg:block" aria-hidden="true" />
          <button
            type="button"
            onClick={onToggleDetails}
            className="hidden min-w-0 flex-1 cursor-pointer truncate text-left text-[12px] text-kumo-subtle hover:text-kumo-default lg:block"
          >
            {channel.topic}
          </button>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!isDirect(channel) && (
          <button
            type="button"
            onClick={onToggleDetails}
            className="press hidden h-7 cursor-pointer items-center gap-1.5 rounded-md border border-kumo-line px-2 text-[12px] text-kumo-subtle transition-colors hover:border-kumo-ring hover:text-kumo-default sm:inline-flex"
          >
            <Users size={13} />
            {pluralise(channel.memberCount, "member")}
          </button>
        )}
        {membership !== undefined && (
          <div className="relative">
            <IconButton
              label="Notification preferences"
              onClick={() => setNotifyOpen((open) => !open)}
              active={notifyOpen}
            >
              <CaretDown size={14} />
            </IconButton>
            {notifyOpen && (
              <>
                <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setNotifyOpen(false)} />
                <div
                  role="menu"
                  className="absolute top-8 right-0 z-20 w-56 overflow-hidden rounded-lg border border-kumo-line bg-kumo-control py-1 shadow-lg"
                >
                  <p className="px-3 py-1.5 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">
                    Notify me about
                  </p>
                  {(["all", "mentions", "none"] as NotifyLevel[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="menuitemradio"
                      aria-checked={membership.notify === level}
                      onClick={() => {
                        void store.setNotify(channelId, level);
                        setNotifyOpen(false);
                      }}
                      className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint"
                    >
                      {level === "all" ? "Every message" : level === "mentions" ? "Mentions only" : "Nothing"}
                      {membership.notify === level && <span className="text-kumo-brand">✓</span>}
                    </button>
                  ))}
                  <div className="my-1 h-px bg-kumo-line" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={membership.muted}
                    onClick={() => {
                      void store.toggleMute(channelId);
                      setNotifyOpen(false);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint"
                  >
                    <BellSlash size={14} className="text-kumo-subtle" />
                    {membership.muted ? "Unmute conversation" : "Mute conversation"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <IconButton label="Conversation details" onClick={onToggleDetails} active={detailsOpen}>
          <Info size={15} />
        </IconButton>
      </div>
    </header>
  );
}
