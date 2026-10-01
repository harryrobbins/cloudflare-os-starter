// An incoming call: a card in the toast stack with Join and Dismiss.
//
// Raised by the store for a `call` event with `ring` (a dm or group call somebody else started), and
// gone after thirty seconds, when the call ends, or when this frame joins it. Join navigates to the
// conversation and opens the pre-join pane rather than joining outright, so the camera prompt comes
// with a preview -- and so the click that finally joins is the user gesture audio playback needs.

import { PhoneIncoming, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { Channel, User } from "../../contract.js";
import { channelLabel } from "../../lib/labels.js";
import type { CallRing } from "../../store/calls.js";
import { Avatar } from "../../components/primitives.js";

export function IncomingCall({
  ring,
  caller,
  channel,
  users,
  meId,
  onJoin,
  onDismiss,
}: {
  ring: CallRing;
  caller: User | undefined;
  channel: Channel | undefined;
  users: Readonly<Record<string, User>>;
  meId: string | undefined;
  onJoin: () => void;
  onDismiss: () => void;
}): ReactNode {
  const name = caller?.name ?? "Someone";
  const where = channel === undefined || channel.kind === "dm" ? null : channelLabel(channel, users, meId);
  return (
    <div
      role="alertdialog"
      aria-label={`${name} is calling`}
      data-testid="incoming-call"
      className="chat-rise pointer-events-auto flex items-center gap-3 rounded-xl border border-kumo-success/40 bg-kumo-control p-3 shadow-xl"
    >
      <span className="relative shrink-0">
        <Avatar name={name} id={ring.startedBy} size={36} />
        <span className="chat-ring absolute -inset-1 rounded-[32%] ring-2 ring-kumo-success" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-kumo-strong">{name} is calling</span>
        <span className="flex min-w-0 items-center gap-1 text-[12px] text-kumo-subtle">
          <PhoneIncoming size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{where === null ? "Video call" : `Video call in ${where}`}</span>
        </span>
      </span>
      <button
        type="button"
        onClick={onJoin}
        className="press shrink-0 cursor-pointer rounded-full bg-kumo-success px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110"
      >
        Join
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="press inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
      >
        <X size={13} />
      </button>
    </div>
  );
}
