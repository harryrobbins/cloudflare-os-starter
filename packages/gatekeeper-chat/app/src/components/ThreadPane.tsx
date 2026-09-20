// The thread pane: the root message, its replies, and a composer with the "Also send to #channel"
// toggle. It has its own draft key (`channelId:rootId`) so a half-written reply survives switching
// back to the channel and returning.

import { X } from "@phosphor-icons/react";
import { useCallback, useEffect, type ReactNode } from "react";

import type { Message } from "../contract.js";
import { channelLabel } from "../lib/labels.js";
import { permalinkUrl } from "../lib/nav.js";
import { pluralise } from "../lib/format.js";
import { useChat, useStore } from "../hooks/store.js";
import { conversationKey } from "../store/drafts.js";
import { EMPTY_CONVERSATION } from "../store/state.js";
import { Composer } from "./Composer.js";
import { MessageList } from "./MessageList.js";
import { Button, EmptyState, IconButton } from "./primitives.js";

export function ThreadPane({
  channelId,
  rootId,
  onClose,
}: {
  channelId: string;
  rootId: string;
  onClose: () => void;
}): ReactNode {
  const store = useStore();
  const key = conversationKey(channelId, rootId);
  const channel = useChat((state) => state.channels[channelId]);
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const conversation = useChat((state) => state.conversations[key] ?? EMPTY_CONVERSATION);
  const thread = useChat((state) => state.threads.find((candidate) => candidate.rootId === rootId));
  const channelMessages = useChat(
    (state) => state.conversations[conversationKey(channelId)]?.messages ?? EMPTY_CONVERSATION.messages,
  );

  useEffect(() => {
    void store.openConversation(channelId, { rootId });
  }, [store, channelId, rootId]);

  const onCopyLink = useCallback(
    (message: Message) => {
      void navigator.clipboard
        ?.writeText(permalinkUrl(message.channelId, message.id))
        .then(() => store.toast({ tone: "success", title: "Link copied" }))
        .catch(() => store.toast({ tone: "error", title: "Could not copy the link" }));
    },
    [store],
  );

  /**
   * `GET messages?rootId=` returns the thread *including its root* (`src/do/messages.ts`: the filter is
   * `root_id = ? OR id = ?`), so the pane never has to fetch the root separately -- not even on a deep
   * link straight to `/c/<id>/t/<root>`, which is what the narrow layout does. The channel view behind
   * the pane may not have loaded, so it is a fallback for the already-open case, not a recovery path.
   */
  const root =
    conversation.messages.find((message) => message.id === rootId) ??
    channelMessages.find((message) => message.id === rootId);
  const replies = conversation.messages.filter((message) => message.rootId === rootId);
  const label = channel === undefined ? "" : channelLabel(channel, users, meId);
  const following = thread?.following ?? true;

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-kumo-line bg-kumo-base">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-kumo-line px-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-kumo-strong">Thread</h2>
          <p className="truncate text-[11px] text-kumo-subtle">{label}</p>
        </div>
        <Button
          size="sm"
          variant={following ? "secondary" : "primary"}
          onClick={() => void store.setFollowing(rootId, !following)}
        >
          {following ? "Following" : "Follow"}
        </Button>
        <IconButton label="Close thread" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      {root === undefined && !conversation.loading ? (
        <EmptyState icon={<X size={18} />} title="That thread is no longer available" />
      ) : (
        <>
          <MessageList
            key={key}
            messages={root === undefined ? replies : [root, ...replies]}
            meId={meId}
            firstUnreadSeq={null}
            loading={conversation.loading}
            loadingOlder={conversation.loadingOlder}
            hasMoreBefore={false}
            focusMessageId={null}
            canThread={false}
            showStart={false}
            emptyState={
              <EmptyState
                icon={<X size={18} />}
                title="No replies yet"
                body="Reply below to start the thread."
              />
            }
            onLoadOlder={() => undefined}
            onAtBottomChange={(atBottom) => store.setAtBottom(channelId, rootId, atBottom)}
            onOpenThread={() => undefined}
            onCopyLink={onCopyLink}
            onMarkUnread={(message) => void store.markUnreadFrom(channelId, message.seq)}
            onMentionClick={(kind, id) => {
              if (kind === "user") void store.openDm(id);
            }}
            onRetry={(clientId) => void store.retrySend(channelId, key, clientId)}
            onDiscard={(clientId) => store.discardSend(key, clientId)}
            onFocusHandled={() => store.clearFocusMessage(channelId, rootId)}
          />
          <p className="px-5 pb-1 text-[11px] text-kumo-inactive">
            {pluralise(replies.length, "reply", "replies")} in this thread
          </p>
          <Composer
            channelId={channelId}
            rootId={rootId}
            conversationKey={key}
            placeholder="Reply in thread"
            showAlsoSend
            channelName={label}
          />
        </>
      )}
    </div>
  );
}
