// The composer.
//
// Enter sends and Shift+Enter is a newline; the textarea autosizes between one and twelve lines. The
// three autocompletes (`@` people, `#` channels, `:` emoji) share one mechanism: find the trigger token
// immediately before the caret, offer matches, and replace that range on accept. `@` and `#` insert an
// *id token* (`<@u-alice>`) while showing the display name, because "display names are neither unique
// nor stable" -- the server resolves the id at post time.
//
// Uploads start the moment a file is pasted or dropped, so the progress bar is real rather than a
// pre-send fiction, and a queued attachment can be removed before the message is sent.

import { At, Hash, Paperclip, PaperPlaneRight, SmileySticker, X } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { MAX_BODY_BYTES, utf8Bytes, type Channel, type User } from "../contract.js";
import { findTrigger, type Trigger } from "../lib/autocomplete.js";
import { searchEmoji } from "../lib/emoji.js";
import { formatBytes } from "../lib/format.js";
import { channelLabel } from "../lib/labels.js";
import { useChat, useStore } from "../hooks/store.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { Avatar, IconButton, Spinner } from "./primitives.js";

const MAX_ROWS = 12;
const TYPING_THROTTLE_MS = 2500;

type Suggestion =
  | { kind: "user"; id: string; label: string; detail: string; user: User }
  | { kind: "channel"; id: string; label: string; detail: string }
  | { kind: "emoji"; id: string; label: string; detail: string };

export function Composer({
  channelId,
  rootId = null,
  conversationKey,
  placeholder,
  autoFocus = false,
  showAlsoSend = false,
  channelName,
}: {
  channelId: string;
  rootId?: string | null;
  conversationKey: string;
  placeholder: string;
  autoFocus?: boolean;
  showAlsoSend?: boolean;
  channelName?: string;
}): ReactNode {
  const store = useStore();
  const draft = useChat((state) => state.drafts[conversationKey]?.body ?? "");
  const uploads = useChat((state) => state.uploads[conversationKey] ?? EMPTY_UPLOADS);
  const users = useChat((state) => state.users);
  const channels = useChat((state) => state.channels);
  const meId = useChat((state) => state.me?.id);
  const maxBytes = useChat((state) => state.limits.maxBodyBytes);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [alsoSend, setAlsoSend] = useState(false);
  const [caret, setCaret] = useState(0);

  const trigger = useMemo(() => findTrigger(draft, caret), [draft, caret]);
  const suggestions = useMemo(
    () => (trigger === null ? [] : suggest(trigger, users, channels, meId)),
    [trigger, users, channels, meId],
  );

  useEffect(() => setActiveIndex(0), [trigger?.query, trigger?.kind]);

  // Autosize: reset then grow to the content, capped, so a long draft scrolls instead of eating the view.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    const lineHeight = 20;
    const max = lineHeight * MAX_ROWS;
    textarea.style.height = `${Math.min(max, textarea.scrollHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus, conversationKey]);

  const bytes = utf8Bytes(draft);
  const overLimit = bytes > maxBytes;
  const uploading = uploads.some((upload) => upload.state === "uploading");
  const canSend =
    !overLimit &&
    !uploading &&
    (draft.trim().length > 0 || uploads.some((upload) => upload.state === "ready"));

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      store.setDraft(conversationKey, event.target.value);
      setCaret(event.target.selectionStart);
      const now = Date.now();
      if (event.target.value.length > 0 && now - lastTypingAt.current > TYPING_THROTTLE_MS) {
        lastTypingAt.current = now;
        store.typingIn(channelId);
      }
    },
    [store, conversationKey, channelId],
  );

  function accept(suggestion: Suggestion): void {
    if (trigger === null) return;
    // The *display* form goes in the textarea -- `@Alice Chen`, not `<@u-alice>`. `resolveMentions`
    // turns it back into ids on the way out; see lib/mentions.ts for why it is done there.
    const insert =
      suggestion.kind === "user"
        ? `@${suggestion.label} `
        : suggestion.kind === "channel"
          ? `${suggestion.label} `
          : `${suggestion.id} `;
    const next = draft.slice(0, trigger.start) + insert + draft.slice(trigger.end);
    store.setDraft(conversationKey, next);
    const position = trigger.start + insert.length;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = suggestions[activeIndex];
        if (chosen !== undefined) accept(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCaret(-1);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function submit(): void {
    if (!canSend) return;
    void store.send(channelId, { rootId, alsoSendToChannel: alsoSend });
    setAlsoSend(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function addFiles(files: FileList | File[] | null): void {
    if (files === null) return;
    for (const file of Array.from(files)) {
      void store.queueUpload(channelId, conversationKey, file);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(false);
    addFiles(event.dataTransfer.files);
  }

  return (
    <div className="relative px-4 pt-1 pb-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={[
          "field relative rounded-xl border bg-kumo-control transition-colors",
          dragOver
            ? "border-kumo-brand bg-kumo-brand/5"
            : overLimit
              ? "border-kumo-danger"
              : "border-kumo-line",
        ].join(" ")}
      >
        {suggestions.length > 0 && (
          <SuggestionList
            suggestions={suggestions}
            activeIndex={activeIndex}
            onPick={accept}
            onHover={setActiveIndex}
          />
        )}

        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-kumo-line p-2.5">
            {uploads.map((upload) => (
              <div
                key={upload.key}
                className="group relative flex w-40 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated p-1.5"
              >
                {upload.previewUrl !== null ? (
                  <img
                    src={upload.previewUrl}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-kumo-fill text-[10px] font-semibold text-kumo-subtle uppercase">
                    {upload.name.split(".").pop()?.slice(0, 4) ?? "file"}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium text-kumo-default">
                    {upload.name}
                  </span>
                  {upload.state === "uploading" ? (
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-kumo-fill">
                      <span
                        className="block h-full rounded-full bg-kumo-brand transition-[width]"
                        style={{ width: `${Math.round(upload.progress * 100)}%` }}
                      />
                    </span>
                  ) : upload.state === "failed" ? (
                    <span className="block text-[10px] text-kumo-danger">Upload failed</span>
                  ) : (
                    <span className="block text-[10px] text-kumo-subtle">
                      {formatBytes(upload.bytes)}
                    </span>
                  )}
                </span>
                <IconButton
                  label={`Remove ${upload.name}`}
                  onClick={() => store.removeUpload(conversationKey, upload.key)}
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <X size={11} />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          className="block w-full resize-none bg-transparent px-3.5 py-2.5 text-[13px] leading-5 text-kumo-default outline-none placeholder:text-kumo-inactive"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <label className="press inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <Paperclip size={15} />
            <span className="sr-only">Attach a file</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <IconButton label="Emoji" onClick={() => setPickerOpen(true)}>
            <SmileySticker size={15} />
          </IconButton>
          <IconButton
            label="Mention someone"
            onClick={() => {
              store.setDraft(conversationKey, `${draft}${draft.endsWith(" ") || draft.length === 0 ? "" : " "}@`);
              requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                textarea?.focus();
                const end = textarea?.value.length ?? 0;
                textarea?.setSelectionRange(end, end);
                setCaret(end);
              });
            }}
          >
            <At size={15} />
          </IconButton>

          <span className="ml-auto flex items-center gap-2">
            {overLimit && (
              <span className="text-[11px] font-medium text-kumo-danger tabular-nums">
                {formatBytes(bytes)} / {formatBytes(maxBytes)}
              </span>
            )}
            {!overLimit && bytes > MAX_BODY_BYTES * 0.8 && (
              <span className="text-[11px] text-kumo-subtle tabular-nums">
                {formatBytes(maxBytes - bytes)} left
              </span>
            )}
            <span className="hidden text-[11px] text-kumo-inactive sm:inline">
              <kbd className="font-sans">Enter</kbd> to send
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              className={[
                "press inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                canSend
                  ? "cursor-pointer bg-kumo-brand text-white hover:bg-kumo-brand-hover"
                  : "cursor-not-allowed bg-kumo-fill text-kumo-inactive",
              ].join(" ")}
            >
              {uploading ? <Spinner size={12} /> : <PaperPlaneRight size={14} weight="fill" />}
            </button>
          </span>
        </div>

        {pickerOpen && (
          <EmojiPicker
            onPick={(emoji) => {
              setPickerOpen(false);
              store.setDraft(conversationKey, draft + emoji);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      {showAlsoSend && rootId !== null && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-kumo-subtle">
          <input
            type="checkbox"
            checked={alsoSend}
            onChange={(event) => setAlsoSend(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-kumo-brand)]"
          />
          Also send to {channelName ?? "the channel"}
        </label>
      )}
    </div>
  );
}

const EMPTY_UPLOADS: never[] = [];

function suggest(
  trigger: Trigger,
  users: Readonly<Record<string, User>>,
  channels: Readonly<Record<string, Channel>>,
  meId: string | undefined,
): Suggestion[] {
  const needle = trigger.query.toLowerCase();
  if (trigger.kind === "user") {
    const matches = Object.values(users)
      .filter((user) => user.name.toLowerCase().includes(needle) || user.email?.toLowerCase().startsWith(needle) === true)
      .toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .slice(0, 7);
    return matches.map((user) => ({
      kind: "user" as const,
      id: user.id,
      label: user.name,
      detail: user.id === meId ? "you" : (user.email ?? ""),
      user,
    }));
  }
  if (trigger.kind === "channel") {
    return Object.values(channels)
      .filter((channel) => channel.name !== null && channel.name.includes(needle))
      .toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .slice(0, 7)
      .map((channel) => ({
        kind: "channel" as const,
        id: channel.id,
        label: channelLabel(channel, users, meId),
        detail: channel.topic ?? "",
      }));
  }
  return searchEmoji(needle).map((entry) => ({
    kind: "emoji" as const,
    id: entry.emoji,
    label: `:${entry.name}:`,
    detail: entry.emoji,
  }));
}

function SuggestionList({
  suggestions,
  activeIndex,
  onPick,
  onHover,
}: {
  suggestions: readonly Suggestion[];
  activeIndex: number;
  onPick: (suggestion: Suggestion) => void;
  onHover: (index: number) => void;
}): ReactNode {
  return (
    <div
      role="listbox"
      aria-label="Suggestions"
      className="absolute right-0 bottom-full left-0 z-20 mb-1.5 overflow-hidden rounded-xl border border-kumo-line bg-kumo-control py-1 shadow-xl"
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={`${suggestion.kind}:${suggestion.id}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            // mousedown, not click: a click would blur the textarea first and lose the caret.
            event.preventDefault();
            onPick(suggestion);
          }}
          className={[
            "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
            index === activeIndex ? "bg-kumo-tint" : "",
          ].join(" ")}
        >
          {suggestion.kind === "user" ? (
            <Avatar name={suggestion.user.name} id={suggestion.user.id} size={20} />
          ) : suggestion.kind === "channel" ? (
            <Hash size={16} className="text-kumo-subtle" />
          ) : (
            <span className="w-5 text-center text-[15px]" aria-hidden="true">
              {suggestion.detail}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">
            {suggestion.label}
          </span>
          {suggestion.kind !== "emoji" && suggestion.detail.length > 0 && (
            <span className="shrink-0 truncate text-[11px] text-kumo-inactive">
              {suggestion.detail}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
