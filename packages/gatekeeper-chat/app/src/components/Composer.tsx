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

import { At, Hash, Paperclip, PaperPlaneRight, Robot, Terminal, SmileySticker, X } from "@phosphor-icons/react";
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
import { transformPaste, type PasteKind } from "../lib/paste.js";
import { rankItems } from "../lib/fuzzy.js";
import {
  applyTextCommand,
  completeSlash,
  parseSlash,
  slashSuggestions,
  type SlashCommand,
} from "../lib/slash.js";
import { searchEmoji } from "../lib/emoji.js";
import { formatBytes } from "../lib/format.js";
import { channelLabel } from "../lib/labels.js";
import { useChat, useStore } from "../hooks/store.js";
import { composerAgentNote } from "../lib/agent.js";
import { useNavigate } from "@tanstack/react-router";
import { EmojiPicker } from "./EmojiPicker.js";
import { Avatar, IconButton, Spinner } from "./primitives.js";

const MAX_ROWS = 12;
const TYPING_THROTTLE_MS = 2500;

type Suggestion =
  | { kind: "user"; id: string; label: string; detail: string; user: User }
  | { kind: "channel"; id: string; label: string; detail: string }
  | { kind: "emoji"; id: string; label: string; detail: string }
  | { kind: "command"; id: string; label: string; detail: string; command: SlashCommand };

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
  const navigate = useNavigate();
  const draft = useChat((state) => state.drafts[conversationKey]?.body ?? "");
  const uploads = useChat((state) => state.uploads[conversationKey] ?? EMPTY_UPLOADS);
  const users = useChat((state) => state.users);
  const channels = useChat((state) => state.channels);
  const meId = useChat((state) => state.me?.id);
  const maxBytes = useChat((state) => state.limits.maxBodyBytes);
  const agentReplies = useChat((state) => state.agentReplies);
  // Said before sending, not after: what asking the Agent shares, or that it will not be asked here.
  const agentNote = composerAgentNote(channels[channelId], draft, agentReplies);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [alsoSend, setAlsoSend] = useState(false);
  const [caret, setCaret] = useState(0);
  /**
   * The last paste this composer rewrote, kept so it can be put back.
   *
   * A programmatic `setDraft` is invisible to the textarea's own undo stack, so Ctrl+Z after a
   * rewrite either does nothing or undoes the wrong thing. The hint is the undo.
   */
  const [pasteUndo, setPasteUndo] = useState<{
    readonly kind: PasteKind;
    readonly value: string;
    readonly caret: number;
  } | null>(null);

  const trigger = useMemo(() => findTrigger(draft, caret), [draft, caret]);
  /**
   * One list, two sources. A command picker is only ever open at the very start of a draft, and the
   * `@`/`#`/`:` triggers cannot fire there, so they never compete for the same keystrokes.
   */
  const suggestions = useMemo<Suggestion[]>(() => {
    const commands = slashSuggestions(draft, caret);
    if (commands !== null) {
      return commands.map((command) => ({
        kind: "command" as const,
        id: command.name,
        label: `/${command.name}`,
        detail: command.summary,
        command,
      }));
    }
    return trigger === null ? [] : suggest(trigger, users, channels, meId);
  }, [draft, caret, trigger, users, channels, meId]);

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

  useEffect(() => setPasteUndo(null), [conversationKey]);

  useEffect(() => {
    if (pasteUndo === null) return;
    const timer = setTimeout(() => setPasteUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [pasteUndo]);

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
    if (suggestion.kind === "command") {
      const completed = completeSlash(draft, suggestion.command);
      store.setDraft(conversationKey, completed.value);
      restoreCaret(completed.caret);
      return;
    }
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
    if (runCommand()) return;
    void store.send(channelId, { rootId, alsoSendToChannel: alsoSend });
    setAlsoSend(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /**
   * Handles the draft if it is a *known* command, and reports whether it did.
   *
   * An unknown `/something` falls through and is posted as an ordinary message, which is why there
   * is no escape syntax to learn.
   */
  function runCommand(): boolean {
    const parsed = parseSlash(draft.trim());
    if (parsed === null || parsed.command === undefined) return false;

    // The two that are really just typing: rewrite the draft and send it the normal way.
    const rewritten = applyTextCommand(parsed);
    if (rewritten !== null) {
      store.setDraft(conversationKey, rewritten);
      // The draft is state, and `send` reads it, so this has to be the next tick rather than now.
      requestAnimationFrame(() => {
        void store.send(channelId, { rootId, alsoSendToChannel: alsoSend });
        setAlsoSend(false);
        textareaRef.current?.focus();
      });
      return true;
    }
    if (parsed.name === "me") {
      store.toast({ tone: "info", title: "/me needs something to say", body: parsed.command.example });
      return true;
    }

    const clear = (): void => {
      store.setDraft(conversationKey, "");
      requestAnimationFrame(() => textareaRef.current?.focus());
    };

    switch (parsed.name) {
      case "topic": {
        void store.updateChannel(channelId, { topic: parsed.rest.length === 0 ? null : parsed.rest });
        clear();
        return true;
      }
      case "mute":
      case "unmute": {
        void store.setMuted(channelId, parsed.name === "mute");
        clear();
        return true;
      }
      case "search": {
        if (parsed.rest.length === 0) {
          store.toast({ tone: "info", title: "What should I search for?", body: parsed.command.example });
          return true;
        }
        clear();
        void navigate({ to: "/search", search: { q: parsed.rest } });
        return true;
      }
      case "dm": {
        const person = resolvePerson(parsed.rest, users, meId);
        if (person === null) {
          store.toast({
            tone: "error",
            title: "Nobody matches that name",
            body: "Try /dm with the name as it appears in People.",
          });
          return true;
        }
        clear();
        void navigate({ to: "/dm/$userId", params: { userId: person } });
        return true;
      }
      default:
        return false;
    }
  }

  function addFiles(files: FileList | File[] | null): void {
    if (files === null) return;
    for (const file of Array.from(files)) {
      void store.queueUpload(channelId, conversationKey, file);
    }
  }

  /** Puts the caret back after a programmatic `setDraft`, which resets the textarea's selection. */
  function restoreCaret(position: number): void {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }

    const pasted = event.clipboardData.getData("text/plain");
    if (pasted.length === 0) return;
    const textarea = event.currentTarget;
    const transform = transformPaste({
      value: draft,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      pasted,
    });
    if (transform === null) return;
    event.preventDefault();
    setPasteUndo({ kind: transform.kind, value: draft, caret: textarea.selectionEnd });
    store.setDraft(conversationKey, transform.value);
    restoreCaret(transform.selectionStart);
  }

  function undoPaste(): void {
    if (pasteUndo === null) return;
    store.setDraft(conversationKey, pasteUndo.value);
    restoreCaret(pasteUndo.caret);
    setPasteUndo(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(false);
    addFiles(event.dataTransfer.files);
  }

  return (
    <div className="relative px-4 pt-1 pb-4">
      {agentNote !== null && (
        <p
          role="note"
          data-testid="agent-note"
          className={[
            "mb-1.5 flex items-start gap-1.5 px-1 text-[11px] leading-4",
            agentNote.tone === "warn" ? "text-kumo-warning" : "text-kumo-subtle",
          ].join(" ")}
        >
          <Robot size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{agentNote.text}</span>
        </p>
      )}
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

      {pasteUndo !== null && (
        <p className="chat-rise mt-1.5 flex items-center gap-1.5 text-[11px] text-kumo-subtle">
          <span>
            {pasteUndo.kind === "code"
              ? "Pasted as a code block."
              : "Pasted as a link on the selected text."}
          </span>
          <button
            type="button"
            onClick={undoPaste}
            className="cursor-pointer font-medium text-kumo-link underline underline-offset-2 hover:no-underline"
          >
            Undo
          </button>
        </p>
      )}

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

/**
 * Who `/dm alice` means.
 *
 * An exact name wins outright; otherwise the fuzzy matcher picks, and an ambiguous result is still a
 * result -- the worst case is landing in the wrong conversation, which is one click to undo, and a
 * refusal to guess would make the command useless for anybody with a surname.
 */
function resolvePerson(
  query: string,
  users: Readonly<Record<string, User>>,
  meId: string | undefined,
): string | null {
  const needle = query.replace(/^@/, "").trim();
  if (needle.length === 0) return null;
  const candidates = Object.values(users).filter((user) => user.id !== meId);
  const exact = candidates.find((user) => user.name.toLowerCase() === needle.toLowerCase());
  if (exact !== undefined) return exact.id;
  const byEmail = candidates.find((user) => user.email?.toLowerCase() === needle.toLowerCase());
  if (byEmail !== undefined) return byEmail.id;
  return rankItems(candidates, needle, (user) => user.name)[0]?.item.id ?? null;
}

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
          ) : suggestion.kind === "command" ? (
            <Terminal size={16} className="text-kumo-subtle" />
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
