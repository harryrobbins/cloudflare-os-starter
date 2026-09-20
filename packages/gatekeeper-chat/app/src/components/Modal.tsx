// One dialog treatment for the app's three modals (new channel, new message, confirm).
//
// Focus is trapped for as long as it is open and returned to the trigger on close, Escape dismisses,
// and the backdrop click does too. Deliberately hand-rolled rather than pulled from a component
// library: it is forty lines, and the app needs exactly this shape.

import { X } from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";

import { IconButton } from "./primitives.js";

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = "sm",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md";
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("input, textarea, button, [tabindex]")?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panel === null) return;
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1250] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={[
          "chat-rise flex w-full flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-2xl",
          width === "sm" ? "max-w-md" : "max-w-xl",
        ].join(" ")}
      >
        <div className="flex items-start gap-3 border-b border-kumo-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-kumo-strong">{title}</h2>
            {description !== undefined && (
              <p className="mt-0.5 text-[12px] text-kumo-subtle">{description}</p>
            )}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="quiet-scroll max-h-[60vh] min-h-0 overflow-y-auto px-4 py-4">{children}</div>
        {footer !== undefined && (
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
