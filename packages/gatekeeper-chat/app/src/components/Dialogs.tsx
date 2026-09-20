// New channel and New message.

import { Hash, LockSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";

import { MAX_CHANNEL_NAME_LENGTH, MAX_TOPIC_LENGTH, type ChannelKind } from "../contract.js";
import { useChat, useStore } from "../hooks/store.js";
import { Avatar, Button } from "./primitives.js";
import { Modal } from "./Modal.js";

export function NewChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channelId: string) => void;
}): ReactNode {
  const store = useStore();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<ChannelKind>("public");
  const [busy, setBusy] = useState(false);

  // Server-side rules mirrored here so the error arrives before the round trip, not after it.
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  const invalid = slug.length === 0 || slug.length > MAX_CHANNEL_NAME_LENGTH;

  async function create(): Promise<void> {
    if (invalid || busy) return;
    setBusy(true);
    const channel = await store.createChannel({
      kind,
      name: slug,
      ...(topic.trim().length > 0 ? { topic: topic.trim() } : {}),
    });
    setBusy(false);
    if (channel !== null) onCreated(channel.id);
  }

  return (
    <Modal
      title="New channel"
      description="Channels keep one subject in one place."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={invalid || busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create channel"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-kumo-default">Name</span>
          <span className="flex items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-2.5 field focus-within:border-kumo-brand">
            <Hash size={14} className="shrink-0 text-kumo-inactive" />
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void create()}
              placeholder="release-week"
              maxLength={MAX_CHANNEL_NAME_LENGTH}
              className="w-full bg-transparent py-2 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
            />
          </span>
          {name.trim().length > 0 && slug !== name.trim().toLowerCase() && (
            <span className="mt-1 block text-[11px] text-kumo-subtle">
              Will be created as <strong className="font-medium">#{slug}</strong>
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-kumo-default">
            Topic <span className="text-kumo-inactive">(optional)</span>
          </span>
          <input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            maxLength={MAX_TOPIC_LENGTH}
            placeholder="What is this channel for?"
            className="w-full rounded-lg border border-kumo-line bg-kumo-control px-2.5 py-2 text-[13px] text-kumo-default outline-none focus:border-kumo-brand placeholder:text-kumo-inactive"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] font-medium text-kumo-default">Visibility</legend>
          {(
            [
              { value: "public", icon: <Hash size={15} />, title: "Public", body: "Anyone can find, join and read it." },
              { value: "private", icon: <LockSimple size={15} />, title: "Private", body: "Only invited members can see it." },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={[
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                kind === option.value
                  ? "border-kumo-brand bg-kumo-brand/5"
                  : "border-kumo-line hover:border-kumo-ring",
              ].join(" ")}
            >
              <input
                type="radio"
                name="visibility"
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
                className="mt-0.5 accent-[var(--color-kumo-brand)]"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-kumo-strong">
                  {option.icon}
                  {option.title}
                </span>
                <span className="block text-[12px] text-kumo-subtle">{option.body}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}

export function NewMessageDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (channelId: string) => void;
}): ReactNode {
  const store = useStore();
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(users)
      .filter((user) => user.id !== meId && !picked.includes(user.id))
      .filter(
        (user) =>
          needle.length === 0 ||
          user.name.toLowerCase().includes(needle) ||
          user.email?.toLowerCase().includes(needle) === true,
      )
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [users, query, picked, meId]);

  async function open(): Promise<void> {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    const channelId =
      picked.length === 1
        ? await store.openDm(picked[0]!)
        : ((await store.createChannel({ kind: "group", memberIds: picked }))?.id ?? null);
    setBusy(false);
    if (channelId !== null) onOpened(channelId);
  }

  return (
    <Modal
      title="New message"
      description="Pick one person for a direct message, or several for a group."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={picked.length === 0 || busy} onClick={() => void open()}>
            {picked.length > 1 ? "Start group" : "Start conversation"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-2 py-1.5 field focus-within:border-kumo-brand">
          <MagnifyingGlass size={14} className="shrink-0 text-kumo-inactive" />
          {picked.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setPicked((current) => current.filter((candidate) => candidate !== id))}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-kumo-fill px-2 py-0.5 text-[12px] text-kumo-strong hover:bg-kumo-fill-hover"
            >
              {users[id]?.name ?? id}
              <span aria-hidden="true">×</span>
              <span className="sr-only">Remove</span>
            </button>
          ))}
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && query.length === 0) setPicked((current) => current.slice(0, -1));
              if (event.key === "Enter" && matches[0] !== undefined) {
                setPicked((current) => [...current, matches[0]!.id]);
                setQuery("");
              }
            }}
            placeholder={picked.length === 0 ? "Search people" : ""}
            aria-label="Search people"
            className="min-w-24 flex-1 bg-transparent py-1 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive"
          />
        </div>

        <ul className="flex flex-col gap-0.5">
          {matches.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => {
                  setPicked((current) => [...current, user.id]);
                  setQuery("");
                }}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-kumo-tint"
              >
                <Avatar name={user.name} id={user.id} size={28} online={user.online} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-kumo-default">{user.name}</span>
                  <span className="block truncate text-[11px] text-kumo-inactive">{user.email ?? ""}</span>
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-2 py-6 text-center text-[12px] text-kumo-subtle">
              Nobody else matches that. People appear here once they have opened chat.
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
