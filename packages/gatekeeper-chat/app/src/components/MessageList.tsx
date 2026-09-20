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

import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
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
import { smoothScroll } from "../lib/motion.js";
import type { SeenReader } from "../lib/seen.js";
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
  /**
   * Who has read as far as which message, keyed by message id. Only `dm` and `group` conversations
   * have one; everywhere else it is empty, because `readCursors` is not sent for them.
   */
  readonly seenBy?: ReadonlyMap<string, readonly SeenReader[]>;
  readonly canThread: boolean;
  /**
   * What to render once history has reached the first message. Null in the thread pane, where "the
   * beginning of the conversation" means nothing.
   */
  readonly startCard: ReactNode;
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
  /** The newest message the reader had actually reached, so arrivals below it can be counted. */
  const [bottomAnchorId, setBottomAnchorId] = useState<string | null>(lastMessageId);
  /** Is the "New messages" rule inside the viewport? Starts optimistic so the pill never flashes. */
  const [unreadRuleVisible, setUnreadRuleVisible] = useState(true);
  /** Which way the rule went. Only an *upward* miss is worth an affordance; scrolling up past it
      leaves it below, where "Jump to latest" already covers the way back. */
  const [unreadRuleAbove, setUnreadRuleAbove] = useState(false);
  /** True once the rule has been on screen: reaching it is what retires the jump affordance. */
  const [unreadRuleReached, setUnreadRuleReached] = useState(false);
  const unreadObserverRef = useRef<IntersectionObserver | null>(null);
  const pendingUnreadScroll = useRef(false);

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

  const unreadIndex = useMemo(() => rows.findIndex((row) => row.kind === "unread"), [rows]);

  const needed = focusIndex === -1 ? mounted : Math.max(mounted, rows.length - focusIndex + 10);
  const start = Math.max(0, rows.length - needed);
  const visible = rows.slice(start);

  /**
   * How many messages arrived below the reader since they left the bottom.
   *
   * Their own sends never count: sending re-pins the list, so a pill offering to show you your own
   * message would be nonsense. The anchor is the newest row at the moment the list was last pinned.
   */
  const newBelow = useMemo(() => {
    if (atBottom || bottomAnchorId === null) return 0;
    const index = props.messages.findIndex((message) => message.id === bottomAnchorId);
    if (index === -1) return 0;
    let count = 0;
    for (const message of props.messages.slice(index + 1)) {
      if (message.authorId !== props.meId) count += 1;
    }
    return count;
  }, [atBottom, bottomAnchorId, props.messages, props.meId]);

  // While the list is pinned, the anchor follows the newest row; leaving the bottom freezes it.
  useEffect(() => {
    if (atBottom) setBottomAnchorId(lastMessageId);
  }, [atBottom, lastMessageId]);

  /**
   * The rule is off screen when it is not intersecting -- or when windowing has not mounted it at
   * all, in which case there is no element for the observer to have an opinion about.
   */
  const unreadRuleMounted = unreadIndex !== -1 && unreadIndex >= start;
  const showUnreadJump =
    unreadIndex !== -1 &&
    !unreadRuleReached &&
    // Not mounted at all means windowing has not reached back that far, which can only be upwards.
    (!unreadRuleMounted || (!unreadRuleVisible && unreadRuleAbove));

  const unreadRuleRef = useCallback((node: HTMLDivElement | null) => {
    unreadObserverRef.current?.disconnect();
    unreadObserverRef.current = null;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        setUnreadRuleVisible(entry.isIntersecting);
        if (entry.isIntersecting) setUnreadRuleReached(true);
        const root = entry.rootBounds;
        if (root !== null) setUnreadRuleAbove(entry.boundingClientRect.bottom <= root.top);
      },
      { root: scrollerRef.current, threshold: 0 },
    );
    observer.observe(node);
    unreadObserverRef.current = observer;
  }, []);

  useEffect(() => () => unreadObserverRef.current?.disconnect(), []);

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

  const scrollToUnreadRule = useCallback((): void => {
    const rule = scrollerRef.current?.querySelector<HTMLElement>("[data-unread-rule]");
    rule?.scrollIntoView({ block: "center", behavior: smoothScroll() });
  }, []);

  /**
   * "Jump to first unread". The rule may be above the mounted window, so the window is grown first
   * and the scroll deferred to the layout effect below -- scrolling to an element that is not in the
   * DOM yet silently does nothing.
   */
  const jumpToUnread = useCallback((): void => {
    if (unreadIndex === -1) return;
    const need = Math.min(MAX_MOUNTED, rows.length - unreadIndex + 6);
    if (need > mounted) {
      pendingUnreadScroll.current = true;
      setMounted(need);
      return;
    }
    scrollToUnreadRule();
  }, [unreadIndex, rows.length, mounted, scrollToUnreadRule]);

  useLayoutEffect(() => {
    if (!pendingUnreadScroll.current) return;
    pendingUnreadScroll.current = false;
    scrollToUnreadRule();
  });

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
        ) : (
          props.startCard
        )}

        {visible.map((row) => {
          if (row.kind === "day") {
            return (
              // Sticky, so the day is always answerable while scrolling -- which means it needs the
              // pane's own background, or its hairlines strike through whatever passes underneath.
              <div
                key={row.key}
                // The band is fully opaque, not translucent: a date you cannot read against the
                // message sliding under it is worse than no date at all. The gradient tail softens
                // the edge so the band does not look like a second header.
                className="sticky top-0 z-[4] flex items-center gap-3 bg-kumo-base px-5 py-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-gradient-to-b after:from-kumo-base after:to-transparent after:content-['']"
              >
                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                <span className="rounded-full border border-kumo-line bg-kumo-base px-2.5 py-0.5 text-[11px] font-semibold text-kumo-subtle shadow-[0_1px_2px_rgba(20,17,16,0.05)]">
                  {formatDayDivider(row.at)}
                </span>
                <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
              </div>
            );
          }
          if (row.kind === "unread") {
            return (
              <div
                key={row.key}
                ref={unreadRuleRef}
                data-unread-rule="true"
                className="flex items-center gap-3 px-5 py-1.5"
                role="separator"
              >
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
              seenBy={props.seenBy?.get(row.message.id)}
            />
          );
        })}
        </div>
      </div>

      {/* Returning to unread, top and bottom. The top pill is for the rule you have scrolled past
          or never reached; the bottom one is for what has arrived since you looked away. */}
      {showUnreadJump && (
        <button
          type="button"
          data-testid="jump-to-unread"
          onClick={jumpToUnread}
          // `top-11` clears the sticky day band, which is 36px tall and owns the top of the pane.
          className="press chat-drop absolute top-11 left-1/2 z-[5] inline-flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg"
          style={{ background: "var(--color-chat-unread)" }}
        >
          <ArrowUp size={13} weight="bold" /> Jump to first unread
        </button>
      )}

      {!atBottom && (
        <button
          type="button"
          data-testid={newBelow > 0 ? "new-messages-pill" : "jump-to-latest"}
          onClick={() => scrollToBottom(smoothScroll())}
          className={[
            "press chat-rise absolute right-5 bottom-3 z-[5] inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium shadow-lg transition-colors",
            newBelow > 0
              ? "border border-transparent text-white"
              : "border border-kumo-line bg-kumo-control text-kumo-default hover:border-kumo-ring",
          ].join(" ")}
          style={newBelow > 0 ? { background: "var(--color-chat-unread)" } : undefined}
        >
          {newBelow > 0
            ? `${newBelow} new ${newBelow === 1 ? "message" : "messages"}`
            : "Jump to latest"}
          <ArrowDown size={13} weight={newBelow > 0 ? "bold" : "regular"} />
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
