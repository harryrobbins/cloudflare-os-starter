// Keyboard model for the result list, as a pure function so it is testable without a DOM.
//
// Focus lives either in the search box or on the result listbox. In the listbox:
//   ArrowDown / ArrowUp   move the selection (ArrowUp from the first row returns to the box)
//   Home / End            first / last result
//   Enter                 open the selected result's url (or its preview when it has none)
//   Space / ArrowRight    open the preview pane
//   ArrowLeft / Escape    close the preview; Escape with no preview returns to the box

export type ListAction =
  | { type: "select"; index: number }
  | { type: "focusInput" }
  | { type: "open"; index: number }
  | { type: "preview"; index: number }
  | { type: "closePreview" }
  | { type: "none" };

export function listKeyAction(key: string, index: number, length: number, previewOpen: boolean): ListAction {
  if (length === 0) return key === "Escape" || key === "ArrowUp" ? { type: "focusInput" } : { type: "none" };
  const current = Math.min(Math.max(index, 0), length - 1);
  switch (key) {
    case "ArrowDown":
      return { type: "select", index: Math.min(current + 1, length - 1) };
    case "ArrowUp":
      return index <= 0 ? { type: "focusInput" } : { type: "select", index: current - 1 };
    case "Home":
      return { type: "select", index: 0 };
    case "End":
      return { type: "select", index: length - 1 };
    case "Enter":
      return { type: "open", index: current };
    case " ":
    case "Spacebar":
    case "ArrowRight":
      return { type: "preview", index: current };
    case "ArrowLeft":
      return previewOpen ? { type: "closePreview" } : { type: "none" };
    case "Escape":
      return previewOpen ? { type: "closePreview" } : { type: "focusInput" };
    default:
      return { type: "none" };
  }
}

/** True when a keystroke should not be taken as a global shortcut (the user is typing somewhere). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return false;
}
