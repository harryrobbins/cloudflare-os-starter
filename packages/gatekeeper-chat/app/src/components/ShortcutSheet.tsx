// The `?` sheet.
//
// Every shortcut in the app, in one place, reachable from anywhere no text field owns. It is a
// hand-maintained list rather than something derived from the handlers: the handlers live in five
// components and a derived list would describe the implementation rather than the product.

import type { ReactNode } from "react";

import { Modal } from "./Modal.js";

interface Shortcut {
  readonly keys: readonly string[];
  readonly what: string;
}

interface ShortcutGroup {
  readonly label: string;
  readonly shortcuts: readonly Shortcut[];
}

/** `⌘` on a Mac, `Ctrl` everywhere else. Read once: the platform does not change mid-session. */
function modifier(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent) ? "⌘" : "Ctrl";
}

export function shortcutGroups(mod: string = modifier()): readonly ShortcutGroup[] {
  return [
    {
      label: "Getting around",
      shortcuts: [
        { keys: [mod, "K"], what: "Jump to a channel or a person" },
        { keys: ["#"], what: "…and narrow the list to channels" },
        { keys: ["@"], what: "…and narrow it to people" },
        { keys: ["?"], what: "Show this list" },
        { keys: ["Esc"], what: "Close the thread, the details pane or a dialog" },
      ],
    },
    {
      label: "Reading",
      shortcuts: [
        { keys: ["↑", "↓"], what: "Move between messages" },
        { keys: ["Home"], what: "Go to the oldest message loaded" },
        { keys: ["End"], what: "Go to the newest message" },
      ],
    },
    {
      label: "Writing",
      shortcuts: [
        { keys: ["Enter"], what: "Send" },
        { keys: ["Shift", "Enter"], what: "New line" },
        { keys: ["@"], what: "Mention somebody" },
        { keys: ["#"], what: "Link a channel" },
        { keys: [":"], what: "Insert an emoji by name" },
        { keys: ["/"], what: "Run a command, at the start of a message" },
      ],
    },
  ];
}

export function ShortcutSheet({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Modal
      title="Keyboard shortcuts"
      description="Everything this app answers to."
      width="md"
      onClose={onClose}
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {shortcutGroups().map((group) => (
          <section key={group.label}>
            <h3 className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-kumo-inactive uppercase">
              {group.label}
            </h3>
            <dl className="flex flex-col gap-1.5">
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.what} className="flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 text-[12px] text-kumo-default">{shortcut.what}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {shortcut.keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 font-sans text-[11px] text-kumo-subtle"
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
