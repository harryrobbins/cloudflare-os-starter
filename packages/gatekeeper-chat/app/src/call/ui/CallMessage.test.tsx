import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallSummary, Message } from "../../contract.js";
import { CallMessageView } from "./CallMessage.js";
import { IncomingCall } from "./IncomingCall.js";
import { click, render, type Rendered } from "./render.test-utils.js";

const names: Record<string, string> = { h: "Harry Robbins", a: "Alice Chen", b: "Bob Okafor" };

const message: Message = {
  id: "m1",
  channelId: "c1",
  seq: 4,
  rootId: null,
  authorId: "a",
  body: "Alice Chen started a call",
  kind: "system",
  createdAt: Date.UTC(2026, 8, 30, 10, 2),
  editedAt: null,
  deletedAt: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  attachments: [],
  mentions: [],
};

let rendered: Rendered | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

function view(summary: CallSummary, button: Parameters<typeof CallMessageView>[0]["button"]) {
  const onJoin = vi.fn();
  const onShowCall = vi.fn();
  rendered = render(
    <CallMessageView
      message={{ ...message, call: summary }}
      summary={summary}
      nameOf={(id) => names[id]}
      button={button}
      onJoin={onJoin}
      onShowCall={onShowCall}
    />,
  );
  return { container: rendered.container, onJoin, onShowCall };
}

describe("CallMessageView", () => {
  const active: CallSummary = { id: "call", state: "active", startedAt: 0, endedAt: null, participantIds: ["a"] };

  it("says who started a running call, with Join", () => {
    const { container, onJoin } = view(active, { kind: "join", count: 1, userIds: ["a"] });
    expect(container.textContent).toContain("Alice Chen started a call");
    const join = [...container.querySelectorAll("button")].find((button) => button.textContent === "Join");
    click(join ?? null);
    expect(onJoin).toHaveBeenCalledOnce();
  });

  it("offers no Join once the live call is gone, and says so when full or joined", () => {
    expect(view(active, { kind: "hidden" }).container.querySelector("button")).toBeNull();
    rendered?.unmount();
    expect(view(active, { kind: "full", max: 5 }).container.textContent).toContain("Full (5)");
    rendered?.unmount();
    const joined = view(active, { kind: "in-call" });
    click(joined.container.querySelector("button"));
    expect(joined.onShowCall).toHaveBeenCalledOnce();
  });

  it("reads as the summary once ended", () => {
    const { container } = view(
      { id: "call", state: "ended", startedAt: 0, endedAt: 23 * 60_000, participantIds: ["h", "a", "b"] },
      { kind: "hidden" },
    );
    expect(container.textContent).toContain("Call ended · 23 min · Harry, Alice, Bob");
    expect(container.querySelector("[data-call='ended']")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("IncomingCall", () => {
  it("names the caller and wires Join and Dismiss", () => {
    const onJoin = vi.fn();
    const onDismiss = vi.fn();
    rendered = render(
      <IncomingCall
        ring={{ callId: "call", channelId: "d1", startedBy: "a", at: 0 }}
        caller={{ id: "a", name: "Alice Chen", email: null, avatarKey: null, firstSeenAt: 0, lastSeenAt: 0, tz: null, online: true }}
        channel={undefined}
        users={{}}
        meId="h"
        onJoin={onJoin}
        onDismiss={onDismiss}
      />,
    );
    const card = rendered.container.querySelector("[role='alertdialog']")!;
    expect(card.getAttribute("aria-label")).toBe("Alice Chen is calling");
    const buttons = [...card.querySelectorAll("button")];
    click(buttons.find((button) => button.textContent === "Join") ?? null);
    click(buttons.find((button) => button.getAttribute("aria-label") === "Dismiss") ?? null);
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
