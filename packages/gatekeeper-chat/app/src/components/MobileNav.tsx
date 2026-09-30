import { Link } from "@tanstack/react-router";
import { ChatCircle, House, At, MagnifyingGlass } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** Stable thumb navigation; the drawer also contains Threads, People, Drafts and Settings. */
export function MobileNav({ onConversations }: { onConversations: () => void }): ReactNode {
  const item =
    "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-kumo-subtle";
  return (
    <nav
      aria-label="Chat navigation"
      className="chat-mobile-nav flex shrink-0 border-t border-kumo-line bg-kumo-base"
    >
      <Link
        to="/"
        className={item}
        activeProps={{ className: "text-kumo-brand" }}
        activeOptions={{ exact: true }}
      >
        <House size={20} />
        Inbox
      </Link>
      <button type="button" className={item} onClick={onConversations}>
        <ChatCircle size={20} />
        Conversations
      </button>
      <Link to="/mentions" className={item} activeProps={{ className: "text-kumo-brand" }}>
        <At size={20} />
        Mentions
      </Link>
      <Link
        to="/search"
        search={{ q: "" }}
        className={item}
        activeProps={{ className: "text-kumo-brand" }}
      >
        <MagnifyingGlass size={20} />
        Search
      </Link>
    </nav>
  );
}
