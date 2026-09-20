// The conversation screen and its right pane.
//
// Wide: conversation on the left, thread or details on the right. Narrow (and compact): one at a time,
// with the right pane replacing the conversation and a back affordance returning to it. The route owns
// this rather than the shell, because only the route knows whether a thread is open.

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { ChannelDetails } from "../components/ChannelDetails.js";
import { ConversationView } from "../components/ConversationView.js";
import { ThreadPane } from "../components/ThreadPane.js";
import { useLayout } from "../components/AppShell.js";
import { useStore } from "../hooks/store.js";

export function ChannelScreen({
  channelId,
  rootId = null,
  focusMessageId = null,
}: {
  channelId: string;
  rootId?: string | null;
  focusMessageId?: string | null;
}): ReactNode {
  const navigate = useNavigate();
  const layout = useLayout();
  const store = useStore();
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Opening a thread closes the details pane: they compete for the same column.
  useEffect(() => {
    if (rootId !== null) setDetailsOpen(false);
  }, [rootId]);

  useEffect(() => {
    store.setActive(channelId, rootId);
  }, [store, channelId, rootId]);

  // Escape closes whatever occupies the right pane, which is the behaviour every pane in the shell has.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (rootId !== null) {
        void navigate({ to: "/c/$channelId", params: { channelId } });
        return;
      }
      setDetailsOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, channelId, rootId]);

  const rightPane =
    rootId !== null ? (
      <ThreadPane
        channelId={channelId}
        rootId={rootId}
        onClose={() => void navigate({ to: "/c/$channelId", params: { channelId } })}
      />
    ) : detailsOpen ? (
      <ChannelDetails channelId={channelId} onClose={() => setDetailsOpen(false)} />
    ) : null;

  const conversation = (
    <ConversationView
      channelId={channelId}
      focusMessageId={focusMessageId}
      detailsOpen={detailsOpen}
      onBack={layout.narrow ? layout.openRail : undefined}
      onToggleDetails={() => setDetailsOpen((open) => !open)}
      onOpenThread={(nextRootId) =>
        void navigate({ to: "/c/$channelId/t/$rootId", params: { channelId, rootId: nextRootId } })
      }
    />
  );

  if (layout.narrow) {
    return <div className="min-w-0 flex-1">{rightPane ?? conversation}</div>;
  }

  return (
    <div className="flex min-w-0 flex-1">
      <div className="min-w-0 flex-1">{conversation}</div>
      {rightPane !== null && (
        <div className="w-[min(26rem,38vw)] shrink-0 xl:w-[28rem]">{rightPane}</div>
      )}
    </div>
  );
}
