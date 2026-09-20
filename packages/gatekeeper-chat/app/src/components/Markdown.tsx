// Rendered message body.
//
// `dangerouslySetInnerHTML` with sanitised HTML rather than a React Markdown renderer: `renderMarkdown`
// already returns an allow-listed string, the result is memoised per body, and a chat list re-renders
// often enough that building a React tree for every message body is measurable.
//
// Clicks on a mention chip are intercepted here rather than being anchors, because a channel mention
// has to route through TanStack Router and a user mention opens a DM, neither of which is an href the
// body itself can know.

import { useMemo, type MouseEvent, type ReactNode } from "react";

import { renderMarkdown, renderSnippet } from "../lib/markdown.js";
import { useChat } from "../hooks/store.js";

export function Markdown({
  body,
  onMentionClick,
  className = "",
}: {
  body: string;
  onMentionClick?: (kind: "user" | "channel", id: string) => void;
  className?: string;
}): ReactNode {
  const users = useChat((state) => state.users);
  const channels = useChat((state) => state.channels);
  const meId = useChat((state) => state.me?.id);

  const html = useMemo(
    () =>
      renderMarkdown(body, {
        nameOf: (id) => users[id]?.name,
        channelNameOf: (id) => channels[id]?.name ?? undefined,
        ...(meId === undefined ? {} : { meId }),
      }),
    [body, users, channels, meId],
  );

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    if (onMentionClick === undefined) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-mention]");
    if (target === null) return;
    const kind = target.dataset.mention;
    const id = target.dataset.mentionId;
    if ((kind !== "user" && kind !== "channel") || id === undefined) return;
    event.preventDefault();
    onMentionClick(kind, id);
  }

  return (
    <div
      className={`md text-kumo-default ${className}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** One search result's `snippet()`, with its matches highlighted. */
export function Snippet({ snippet }: { snippet: string }): ReactNode {
  const html = useMemo(() => renderSnippet(snippet), [snippet]);
  return (
    <p
      className="snippet text-[13px] leading-5 text-kumo-default"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
