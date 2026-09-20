// In-app toasts and the offline banner.
//
// A toast raised for an arriving message carries a permalink, so clicking it lands on the message; an
// error toast carries a retry and stays until dismissed. The live region is separate and is *not* the
// toast stack: it announces new messages without moving focus, which a focusable card would.

import { ArrowClockwise, CheckCircle, Info, WarningCircle, WifiSlash, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useChat, useStore } from "../hooks/store.js";
import { IconButton, Spinner } from "./primitives.js";

export function Toasts({
  onNavigate,
}: {
  /** Receives the toast's absolute app path; the router owns turning it into a navigation. */
  onNavigate: (href: string) => void;
}): ReactNode {
  const store = useStore();
  const toasts = useChat((state) => state.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      // Not aria-live: the store's own region announces messages. A double announcement is worse than
      // none, and an error toast is already accompanied by the failed row in the list.
      className="pointer-events-none fixed right-4 bottom-4 z-[1400] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="chat-rise pointer-events-auto flex items-start gap-2.5 rounded-xl border border-kumo-line bg-kumo-control p-3 shadow-xl"
        >
          <span
            className={[
              "mt-0.5 shrink-0",
              toast.tone === "error"
                ? "text-kumo-danger"
                : toast.tone === "success"
                  ? "text-kumo-success"
                  : "text-kumo-brand",
            ].join(" ")}
          >
            {toast.tone === "error" ? (
              <WarningCircle size={16} weight="fill" />
            ) : toast.tone === "success" ? (
              <CheckCircle size={16} weight="fill" />
            ) : (
              <Info size={16} weight="fill" />
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              if (toast.href !== undefined) onNavigate(toast.href);
              store.dismissToast(toast.id);
            }}
            disabled={toast.href === undefined && toast.action === undefined}
            className={[
              "min-w-0 flex-1 text-left",
              toast.href === undefined ? "cursor-default" : "cursor-pointer",
            ].join(" ")}
          >
            <span className="block text-[13px] font-semibold text-kumo-strong">{toast.title}</span>
            {toast.body !== undefined && (
              <span className="mt-0.5 line-clamp-3 block text-[12px] leading-5 text-kumo-subtle">
                {toast.body}
              </span>
            )}
          </button>
          {toast.action !== undefined && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                store.dismissToast(toast.id);
              }}
              className="press shrink-0 cursor-pointer rounded-md border border-kumo-line px-2 py-1 text-[12px] font-medium text-kumo-default hover:bg-kumo-tint"
            >
              {toast.action.label}
            </button>
          )}
          <IconButton label="Dismiss" onClick={() => store.dismissToast(toast.id)} className="h-6 w-6">
            <X size={12} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

/** The connection banner. Visible only when something is actually wrong. */
export function ConnectionBanner(): ReactNode {
  const status = useChat((state) => state.socketStatus);
  const retryIn = useChat((state) => state.retryInSeconds);
  if (status === "open" || status === "idle") return null;

  const reconnecting = status === "reconnecting";
  return (
    <div
      role="status"
      className={[
        "flex shrink-0 items-center justify-center gap-2 px-4 py-1.5 text-[12px] font-medium",
        reconnecting || status === "closed"
          ? "bg-kumo-warning-tint text-kumo-warning"
          : "bg-kumo-tint text-kumo-subtle",
      ].join(" ")}
    >
      {status === "connecting" ? (
        <>
          <Spinner size={11} /> Connecting to chat…
        </>
      ) : reconnecting ? (
        <>
          <WifiSlash size={13} />
          Reconnecting
          {retryIn !== null && retryIn > 0 ? ` in ${retryIn}s` : "…"}
          <ArrowClockwise size={12} className="chat-spin" />
        </>
      ) : (
        <>
          <WifiSlash size={13} /> Disconnected. New messages will appear when the connection returns.
        </>
      )}
    </div>
  );
}

/** Announces arriving messages for screen readers, without moving focus. */
export function LiveRegion(): ReactNode {
  const announcement = useChat((state) => state.announcement);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}
