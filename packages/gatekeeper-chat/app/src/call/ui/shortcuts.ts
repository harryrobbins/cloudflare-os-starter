// The in-call keyboard shortcuts, and which key presses they may take. Push-to-talk borrows Space, which is also
// how a button, a checkbox, a menu item or a text field is operated, so it only applies when focus is
// on something that does not answer to Space itself: the page, a message, a tile.

import type { ChatStore } from "../../store/store.js";

const SPACE_TARGETS_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[role='combobox']",
].join(",");

/** True when Space pressed with focus on `target` belongs to the control, not to push-to-talk. */
export function spaceBelongsToTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest(SPACE_TARGETS_SELECTOR) !== null;
}

/** A bare Space: no modifier, so Shift+Space, Ctrl+Space and the like stay with the browser. */
export function isBareSpace(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  return event.code === "Space" || event.key === " ";
}

type ShortcutStore = Pick<ChatStore, "state" | "pushToTalk" | "toggleCallAudio" | "toggleCallVideo">;

/**
 * The window listeners `CallDock` installs while a call is live: Ctrl/Cmd+D microphone, Ctrl/Cmd+E
 * camera, and push-to-talk on a bare Space held while muted. `release` ends push-to-talk when the key
 * up will never arrive (window blur, hidden tab, the call ending).
 */
export function callKeyHandlers(store: ShortcutStore): {
  onKeyDown(event: KeyboardEvent): void;
  onKeyUp(event: KeyboardEvent): void;
  release(): void;
} {
  return {
    onKeyDown(event) {
      if (isBareSpace(event)) {
        if (spaceBelongsToTarget(event.target)) return;
        // While held, the auto-repeat must not scroll the page either.
        if (store.state.callPushToTalk) {
          event.preventDefault();
          return;
        }
        if (event.repeat || store.state.call.audioEnabled) return;
        event.preventDefault();
        store.pushToTalk(true);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "d") {
        event.preventDefault();
        store.toggleCallAudio();
      } else if (key === "e") {
        event.preventDefault();
        void store.toggleCallVideo();
      }
    },
    onKeyUp(event) {
      if (!store.state.callPushToTalk || (event.code !== "Space" && event.key !== " ")) return;
      event.preventDefault();
      store.pushToTalk(false);
    },
    release() {
      store.pushToTalk(false);
    },
  };
}
