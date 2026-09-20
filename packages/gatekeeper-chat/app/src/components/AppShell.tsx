// The shell: rail, the routed content area, and the overlays that belong to no single view.
//
// Three layouts from one tree. Wide is rail + content (+ the content's own right pane). Narrow is one
// column at a time: the rail becomes a drawer and the content fills the screen, which is exactly what
// the shell's dock wants -- so `?compact=1` forces that branch. `?embed=1` does *not*: it only says a
// shell is listening on `postMessage`, and the shell's full `/chat` page is bridged and wide at once.

import { X } from "@phosphor-icons/react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { useChat } from "../hooks/store.js";
import { navigateToAppPath } from "../lib/navigate.js";
import { NARROW_QUERY, useMediaQuery } from "../hooks/useMedia.js";
import { NewChannelDialog, NewMessageDialog } from "./Dialogs.js";
import { QuickSwitcher } from "./QuickSwitcher.js";
import { ShortcutSheet } from "./ShortcutSheet.js";
import { ConnectionBanner, LiveRegion, Toasts } from "./Toasts.js";
import { Rail } from "./Rail.js";
import { Button, EmptyState, Skeleton } from "./primitives.js";

interface Layout {
  readonly narrow: boolean;
  readonly embedded: boolean;
  openNewChannel: () => void;
  openNewMessage: () => void;
  openRail: () => void;
}

const LayoutContext = createContext<Layout | null>(null);

export function useLayout(): Layout {
  const layout = useContext(LayoutContext);
  if (layout === null) throw new Error("useLayout was called outside the shell.");
  return layout;
}

export function AppShell(): ReactNode {
  const navigate = useNavigate();
  const phase = useChat((state) => state.phase);
  const fatalError = useChat((state) => state.fatalError);
  const embedded = useChat((state) => state.embedded);
  const compact = useChat((state) => state.compact);
  const narrowViewport = useMediaQuery(NARROW_QUERY);
  const narrow = narrowViewport || compact;
  const [railOpen, setRailOpen] = useState(false);
  const [dialog, setDialog] = useState<"channel" | "message" | null>(null);
  const [overlay, setOverlay] = useState<"switcher" | "shortcuts" | null>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  /**
   * The two global keys.
   *
   * `⌘K`/`Ctrl+K` works anywhere, including inside the composer -- that is what makes it a *switcher*
   * rather than a menu item. `?` must not, because `?` is a character: it only opens the sheet when
   * the keystroke is not headed for a text field.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOverlay((current) => (current === "switcher" ? null : "switcher"));
        return;
      }
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        setOverlay((current) => (current === "shortcuts" ? null : "shortcuts"));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => setRailOpen(false), [pathname]);
  useEffect(() => setOverlay(null), [pathname]);

  const layout: Layout = {
    narrow,
    embedded,
    openNewChannel: useCallback(() => setDialog("channel"), []),
    openNewMessage: useCallback(() => setDialog("message"), []),
    openRail: useCallback(() => setRailOpen(true), []),
  };

  if (phase === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-kumo-base">
        <EmptyState
          icon={<X size={20} />}
          title="Chat is not available"
          body={fatalError ?? "The chat service did not respond."}
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  if (phase === "loading") return <LoadingShell narrow={narrow} />;

  return (
    <LayoutContext.Provider value={layout}>
      <div className="flex h-full flex-col overflow-hidden bg-kumo-base">
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1">
          {!narrow && (
            <div className="w-[260px] shrink-0">
              <Rail
                onNewChannel={layout.openNewChannel}
                onNewMessage={layout.openNewMessage}
                onSearch={() => setOverlay("switcher")}
              />
            </div>
          )}

          <main className="flex min-w-0 flex-1">
            <Outlet />
          </main>
        </div>

        {narrow && railOpen && (
          <div className="fixed inset-0 z-[1100] flex" role="dialog" aria-label="Conversations">
            <div className="w-[min(19rem,85vw)] shadow-2xl">
              <Rail
                onNewChannel={() => {
                  setRailOpen(false);
                  layout.openNewChannel();
                }}
                onNewMessage={() => {
                  setRailOpen(false);
                  layout.openNewMessage();
                }}
                onSearch={() => {
                  setRailOpen(false);
                  setOverlay("switcher");
                }}
                onNavigate={() => setRailOpen(false)}
              />
            </div>
            <button
              type="button"
              aria-label="Close the conversation list"
              onClick={() => setRailOpen(false)}
              className="flex-1 cursor-default bg-black/40"
            />
          </div>
        )}

        {overlay === "switcher" && (
          <QuickSwitcher
            onClose={() => setOverlay(null)}
            onOpenChannel={(channelId) => void navigate({ to: "/c/$channelId", params: { channelId } })}
            onOpenPerson={(userId) => void navigate({ to: "/dm/$userId", params: { userId } })}
            onSearch={(q) => void navigate({ to: "/search", search: { q } })}
          />
        )}
        {overlay === "shortcuts" && <ShortcutSheet onClose={() => setOverlay(null)} />}

        <Toasts onNavigate={navigateToAppPath} />
        <LiveRegion />

        {dialog === "channel" && (
          <NewChannelDialog
            onClose={() => setDialog(null)}
            onCreated={(channelId) => {
              setDialog(null);
              void navigate({ to: "/c/$channelId", params: { channelId } });
            }}
          />
        )}
        {dialog === "message" && (
          <NewMessageDialog
            onClose={() => setDialog(null)}
            onOpened={(channelId) => {
              setDialog(null);
              void navigate({ to: "/c/$channelId", params: { channelId } });
            }}
          />
        )}
      </div>
    </LayoutContext.Provider>
  );
}

/** Is this keystroke headed for something the user is typing into? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The first paint, shaped like the app so nothing jumps when the data lands. */
function LoadingShell({ narrow }: { narrow: boolean }): ReactNode {
  return (
    <div className="flex h-full overflow-hidden bg-kumo-base" aria-busy="true">
      {!narrow && (
        <div className="flex w-[260px] shrink-0 flex-col gap-2 border-r border-kumo-line bg-kumo-elevated p-3">
          <Skeleton className="h-8" />
          <div className="mt-4 space-y-1.5">
            {Array.from({ length: 9 }, (_, index) => (
              <Skeleton key={index} className="h-6" />
            ))}
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-kumo-line px-4">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1 space-y-5 p-5">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex gap-3">
              <Skeleton className="h-9 w-9 rounded-[28%]" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
