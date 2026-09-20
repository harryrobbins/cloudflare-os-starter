// The landing page.
//
// `/` used to redirect straight into a conversation, which is fast and tells you nothing: the one
// question you arrive with -- "what happened while I was gone?" -- is the one the client is uniquely
// able to answer, because it already holds the badge summary and the thread list. So `/` answers it,
// and offers the conversation you were last in as the first thing you can click.
//
// All the arithmetic is in `lib/digest.ts`; this file is the arrangement.

import {
  ArrowRight,
  At,
  ChatsCircle,
  Hash,
  LockSimple,
  Sparkle,
  Users,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, type ReactNode } from "react";

import type { ChannelKind } from "../contract.js";
import { computeDigest, greeting, summarise, type DigestConversation } from "../lib/digest.js";
import { useChat, useStore } from "../hooks/store.js";
import { lastChannel, readRecentChannels } from "../store/recents.js";
import { CountBadge, SectionLabel } from "../components/primitives.js";
import { ViewShell } from "./ViewShell.js";

export function InboxView({ onBack }: { onBack?: () => void }): ReactNode {
  const store = useStore();
  const channels = useChat((state) => state.channels);
  const memberships = useChat((state) => state.memberships);
  const badges = useChat((state) => state.badges);
  const users = useChat((state) => state.users);
  const threads = useChat((state) => state.threads);
  const meId = useChat((state) => state.me?.id);
  const myName = useChat((state) => state.prefs.displayName ?? state.me?.name ?? null);

  // The thread half of the digest needs the list, and the rail only loads it on demand.
  useEffect(() => {
    void store.loadThreads();
  }, [store]);

  const recents = useMemo(() => readRecentChannels(), []);
  const digest = useMemo(
    () => computeDigest({ channels, memberships, badges, users, threads, meId, recents }),
    [channels, memberships, badges, users, threads, meId, recents],
  );

  const resume = useMemo(
    () => lastChannel((id) => channels[id] !== undefined && memberships[id] !== undefined),
    [channels, memberships],
  );
  const resumeChannel = resume === null ? undefined : channels[resume];

  return (
    <ViewShell title="Chat" subtitle={summarise(digest)} {...(onBack === undefined ? {} : { onBack })}>
      <div className="flex flex-col gap-7 px-4 py-6 md:px-5">
        <header>
          <h2 className="text-[20px] font-semibold text-kumo-strong">{greeting(Date.now(), myName)}</h2>
          <p className="mt-1 text-[13px] text-kumo-subtle">
            {digest.quiet
              ? "Nothing is waiting for you. Everything you follow is read."
              : summarise(digest)}
          </p>
        </header>

        {resumeChannel !== undefined && (
          <Link
            to="/c/$channelId"
            params={{ channelId: resumeChannel.id }}
            className="press group flex items-center gap-3 rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-3 transition-colors hover:border-kumo-ring hover:bg-kumo-tint"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
              <KindIcon kind={resumeChannel.kind} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold tracking-[0.06em] text-kumo-inactive uppercase">
                Pick up where you left off
              </span>
              <span className="block truncate text-[14px] font-medium text-kumo-strong">
                {digest.recent.find((entry) => entry.channelId === resumeChannel.id)?.label ??
                  labelFor(resumeChannel.id, digest) ??
                  (resumeChannel.name === null ? "Direct message" : `#${resumeChannel.name}`)}
              </span>
            </span>
            <ArrowRight
              size={16}
              className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-brand"
            />
          </Link>
        )}

        {digest.mentions.length > 0 && (
          <Section label="Mentions" icon={<At size={12} />}>
            {digest.mentions.map((entry) => (
              <ConversationRow key={entry.channelId} entry={entry} />
            ))}
          </Section>
        )}

        {digest.unread.length > 0 && (
          <Section label="Unread" icon={<ChatsCircle size={12} />}>
            {digest.unread.map((entry) => (
              <ConversationRow key={entry.channelId} entry={entry} />
            ))}
          </Section>
        )}

        {digest.threads.length > 0 && (
          <Section label="Threads with new replies" icon={<ChatsCircle size={12} />}>
            {digest.threads.map((thread) => (
              <Link
                key={thread.rootId}
                to="/c/$channelId/t/$rootId"
                params={{ channelId: thread.channelId, rootId: thread.rootId }}
                className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-kumo-tint"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-kumo-default">
                    {thread.preview}
                  </span>
                  <span className="block truncate text-[11px] text-kumo-inactive">
                    in {thread.channelLabel}
                  </span>
                </span>
                <CountBadge count={thread.unreadReplies} tone="tint" />
              </Link>
            ))}
          </Section>
        )}

        {digest.quiet && (
          <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-elevated px-4 py-3.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-brand">
              <Sparkle size={16} />
            </span>
            <p className="text-[13px] leading-5 text-kumo-subtle">
              You are all caught up. New messages will badge the rail and appear here; press{" "}
              <kbd className="rounded border border-kumo-line bg-kumo-base px-1 py-px font-sans text-[11px]">
                ?
              </kbd>{" "}
              for the keyboard shortcuts.
            </p>
          </div>
        )}

        {digest.recent.length > 0 && (
          <Section label={digest.quiet ? "Recent conversations" : "Also recently open"}>
            {digest.recent.map((entry) => (
              <ConversationRow key={entry.channelId} entry={entry} />
            ))}
          </Section>
        )}
      </div>
    </ViewShell>
  );
}

function labelFor(
  channelId: string,
  digest: ReturnType<typeof computeDigest>,
): string | undefined {
  return [...digest.mentions, ...digest.unread, ...digest.recent].find(
    (entry) => entry.channelId === channelId,
  )?.label;
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section>
      <p className="mb-1.5 flex items-center gap-1.5 px-2.5">
        {icon !== undefined && <span className="text-kumo-inactive">{icon}</span>}
        <SectionLabel>{label}</SectionLabel>
      </p>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function ConversationRow({ entry }: { entry: DigestConversation }): ReactNode {
  return (
    <Link
      to="/c/$channelId"
      params={{ channelId: entry.channelId }}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-kumo-tint"
    >
      <span className="flex w-5 shrink-0 justify-center text-kumo-subtle">
        <KindIcon kind={entry.kind} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-kumo-strong">
        {entry.label}
      </span>
      {entry.unread > 0 && (
        <span className="shrink-0 text-[11px] text-kumo-subtle tabular-nums">
          {entry.unread} new
        </span>
      )}
      <CountBadge count={entry.mentions} />
    </Link>
  );
}

function KindIcon({ kind }: { kind: ChannelKind }): ReactNode {
  if (kind === "private") return <LockSimple size={15} />;
  if (kind === "dm" || kind === "group") return <Users size={15} />;
  return <Hash size={15} />;
}
