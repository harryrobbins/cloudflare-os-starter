// The conversation list.
//
// Windowing without absolute positioning or a height cache: only the most recent `mounted` rows are in
// the DOM, and scrolling up mounts more (then pages more from the server). A chat list is read from the
// bottom, its rows are variable-height and re-measure whenever an image loads or a reaction lands, and
// every fixed-height virtualiser fights all three. Bounding the mounted count gives the same property
// that matters -- a 10k-message channel never puts 10k nodes on the page -- while the browser keeps
// doing the layout it is good at.
//
// Scroll anchoring is manual: prepending rows changes `scrollHeight`, so the delta is added back to
// `scrollTop` in a layout effect, before paint, which is what stops the jump.

import { ArrowDown } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { Message } from "../contract.js";
import { formatDayDivider } from "../lib/format.js";
import { buildRows } from "../lib/grouping.js";
import type { LocalMessage } from "../store/merge.js";
import { MessageRow } from "./MessageRow.js";
import { MessageSkeletons, Spinner } from "./primitives.js";

/** Rows mounted at rest. Two screens' worth on a tall display. */
const WINDOW = 60;
/** Mounted after each upward step. */
const STEP = 40;
/** Hard ceiling; going back to the bottom trims to `WINDOW` again. */
const MAX_MOUNTED = 400;
/** How close to the bottom still counts as "at the bottom", in pixels. */
const BOTTOM_EPSILON = 48;
/** How close to the top triggers mounting or fetching more. */
const TOP_TRIGGER = 320;

export interface MessageListProps {
  readonly messages: readonly LocalMessage[];
  readonly meId: string | undefined;
  readonly firstUnreadSeq: number | null;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly hasMoreBefore: boolean;
  readonly focusMessageId: string | null;
  readonly emptyState: ReactNode;
  readonly canThread: boolean;
  /** False in the thread pane, where "the beginning of the conversation" means nothing. */
  readonly showStart: boolean;
  readonly onLoadOlder: () => void;
  readonly onAtBottomChange: (atBottom: boolean) => void;
  readonly onOpenThread: (rootId: string) => void;
  readonly onCopyLink: (message: Message) => void;
  readonly onMarkUnread: (message: Message) => void;
  readonly onMentionClick: (kind: "user" | "channel", id: string) => void;
  readonly onRetry: (clientId: string) => void;
  readonly onDiscard: (clientId: string) => void;
  readonly onFocusHandled: () => void;
}

export function MessageList(props: MessageListProps): ReactNode {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(WINDOW);
  const [atBottom, setAtBottom] = useState(true);
  /** The same flag, readable from the ResizeObserver without re-subscribing it on every scroll. */
  const atBottomRef = useRef(true);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastScrollTop = useRef(0);
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const lastMessageId = props.messages[props.messages.length - 1]?.id ?? null;
  const previousLastId = useRef<string | null>(null);

  const rows = useMemo(
    () =>
      buildRows(props.messages, {
        firstUnreadSeq: props.firstUnreadSeq,
        ...(props.meId === undefined ? {} : { meId: props.meId }),
      }),
    [props.messages, props.firstUnreadSeq, props.meId],
  );

  // A permalink target may be outside the default window; mount enough rows to include it.
  const focusIndex = useMemo(
    () =>
      props.focusMessageId === null
        ? -1
        : rows.findIndex((row) => row.kind === "message" && row.message.id === props.focusMessageId),
    [rows, props.focusMessageId],
  );

  const needed = focusIndex === -1 ? mounted : Math.max(mounted, rows.length - focusIndex + 10);
  const start = Math.max(0, rows.length - needed);
  const visible = rows.slice(start);

  /**
   * Re-pins to the bottom whenever the content grows underneath a reader who was already there.
   *
   * Without this, an image finishing its download after the initial scroll leaves the list a few
   * hundred pixels short of the newest message -- which reads as "the app lost my last messages".
   *
   * A callback ref, not an effect: the list is not in the DOM on the first render (the skeleton is),
   * so an effect with an empty dependency array would observe nothing and never run again.
   */
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const scroller = scrollerRef.current;
      if (!atBottomRef.current || scroller === null) return;
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTop.current = scroller.scrollTop;
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    atBottomRef.current = true;
    lastScrollTop.current = scroller.scrollHeight;
  }, []);

  // First paint of a conversation lands at the bottom, or at the permalink's row.
  useLayoutEffect(() => {
    if (props.loading) return;
    if (props.focusMessageId !== null) return;
    scrollToBottom();
    // Only when the conversation itself changes, which the caller signals by remounting via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.loading]);

  // Restore the scroll offset after rows are prepended, before the browser paints.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (scroller === null || anchor === null) return;
    anchorRef.current = null;
    scroller.scrollTop = anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
  }, [visible.length, props.messages]);

  // A new message at the bottom follows the scroll only if the reader was already there.
  useLayoutEffect(() => {
    if (lastMessageId === previousLastId.current) return;
    previousLastId.current = lastMessageId;
    if (atBottom) scrollToBottom();
  }, [lastMessageId, atBottom, scrollToBottom]);

  useEffect(() => {
    if (focusIndex === -1 || props.focusMessageId === null) return;
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>(`[data-message-id="${cssEscape(props.focusMessageId)}"]`);
    target?.scrollIntoView({ block: "center" });
    // Release the highlight after the flash so a later render does not re-trigger it.
    const timer = setTimeout(props.onFocusHandled, 2600);
    return () => clearTimeout(timer);
  }, [focusIndex, props.focusMessageId, props.onFocusHandled, props]);

  const handleScroll = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Growing content (an image loading, a reaction landing) moves the bottom away without the reader
    // moving at all. Only a scroll that actually went *up* is allowed to unpin the list.
    const wentUp = scroller.scrollTop < lastScrollTop.current;
    lastScrollTop.current = scroller.scrollTop;
    const nowAtBottom =
      distanceFromBottom <= BOTTOM_EPSILON || (atBottomRef.current && !wentUp);
    if (nowAtBottom !== atBottom) {
      atBottomRef.current = nowAtBottom;
      setAtBottom(nowAtBottom);
      props.onAtBottomChange(nowAtBottom);
    }
    if (nowAtBottom && mounted > WINDOW) setMounted(WINDOW);

    if (scroller.scrollTop < TOP_TRIGGER) {
      if (start > 0) {
        anchorRef.current = { scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop };
        setMounted((current) => Math.min(MAX_MOUNTED, current + STEP));
      } else if (props.hasMoreBefore && !props.loadingOlder) {
        anchorRef.current = { scrollHeight: scroller.scrollHeight, scrollTop: scroller.scrollTop };
        props.onLoadOlder();
      }
    }
  }, [atBottom, mounted, start, props]);

  /** ArrowUp/ArrowDown walk the rows; Home and End jump to the ends. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const items = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")];
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active === null ? -1 : items.findIndex((item) => item.contains(active));
    let next = index;
    if (event.key === "ArrowUp") next = index <= 0 ? 0 : index - 1;
    if (event.key === "ArrowDown") next = index === -1 ? items.length - 1 : Math.min(items.length - 1, index + 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next === index) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: false });
  }

  if (props.loading && props.messages.length === 0) return <MessageSkeletons />;
  if (!props.loading && props.messages.length === 0) {
    return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.emptyState}</div>;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="list"
        aria-label="Messages"
        className="quiet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none"
      >
        {/* A short conversation sits at the *bottom* of the pane, against the composer, rather than
            stranded at the top under a screen of empty space. */}
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3">
        {start > 0 || props.hasMoreBefore ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-kumo-subtle">
            {props.loadingOlder ? (
              <>
                <Spinner size={12} /> Loading earlier messages…
              </>
            ) : (
              "Scroll up for earlier messages"
            )}
          </div>
        ) : props.showStart ? (
          <div className="px-5 pt-6 pb-2 text-[12px] text-kumo-subtle">
            This is the very beginning of the conversation.
          </div>
        ) : null}

        {visible.map((row) => {
          if (row.kind === "day") {
            return (
              // Sticky, so the day is always answerable while scrolling -- which means it needs the
              // pane's own background, or its hairlines strike through whatever passes underneath.
              <div
                key={row.key}
                className="sticky top-0 z-[2] flex items-center gap-3 bg-kumo-base px-5 py-2"
              >
                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                <span className="rounded-full border border-kumo-line bg-kumo-base px-2.5 py-0.5 text-[11px] font-semibold text-kumo-subtle">
                  {formatDayDivider(row.at)}
                </span>
                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
              </div>
            );
          }
          if (row.kind === "unread") {
            return (
              <div key={row.key} className="flex items-center gap-3 px-5 py-1.5" role="separator">
                <span className="h-px flex-1" style={{ background: "var(--color-chat-unread)" }} aria-hidden="true" />
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                  style={{ background: "var(--color-chat-unread)" }}
                >
                  New messages
                </span>
              </div>
            );
          }
          return (
            <MessageRow
              key={row.key}
              message={row.message}
              startsGroup={row.startsGroup}
              focused={props.focusMessageId === row.message.id}
              canThread={props.canThread}
              onOpenThread={props.onOpenThread}
              onCopyLink={props.onCopyLink}
              onMarkUnread={props.onMarkUnread}
              onMentionClick={props.onMentionClick}
              onRetry={props.onRetry}
              onDiscard={props.onDiscard}
            />
          );
        })}
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          className="press absolute right-5 bottom-3 z-[3] inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-control px-3 py-1.5 text-[12px] font-medium text-kumo-default shadow-lg transition-colors hover:border-kumo-ring"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
    </div>
  );
}

/** `CSS.escape` is not in jsdom, and a message id is opaque, so it is escaped defensively. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
