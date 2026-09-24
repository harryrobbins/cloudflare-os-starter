// The connection/save state machine (src/client/sync/connection.js): pure derivations, status
// text, screen-reader announcement policy and the interim reload policy.
import { describe, expect, it, vi } from "vitest";
import {
  ANNOUNCE_RECONNECT_AFTER_MS, CONNECTION_STATES, ConnectionAnnouncer, SLOW_SAVE_MS, TERMINAL_RECOVERY_MS,
  deriveState, recoveryAction, riskOfLoss, statusText,
} from "../../src/client/sync/connection.js";

describe("deriveState", () => {
  it("maps link, queue and recovery flag onto the documented states", () => {
    expect(deriveState({ link: "connecting", pendingCount: 0 })).toBe("connecting");
    expect(deriveState({ link: "live", pendingCount: 0 })).toBe("live");
    expect(deriveState({ link: "live", pendingCount: 2 })).toBe("saving");
    expect(deriveState({ link: "live", pendingCount: 0, busy: true })).toBe("saving");
    expect(deriveState({ link: "reconnecting", pendingCount: 3 })).toBe("reconnecting");
    expect(deriveState({ link: "reconnecting", pendingCount: 3, recoveryRequired: true })).toBe("recovery-required");
    expect(deriveState({ link: "connecting", pendingCount: 0, recoveryRequired: true })).toBe("recovery-required");
    // A live link wins over a stale recovery flag.
    expect(deriveState({ link: "live", pendingCount: 0, recoveryRequired: true })).toBe("live");
    expect(deriveState({ link: "live", pendingCount: 0, readOnly: true })).toBe("read-only");
    expect(CONNECTION_STATES).toEqual(["connecting", "live", "saving", "reconnecting", "recovery-required", "read-only"]);
  });
});

describe("riskOfLoss", () => {
  it("is false with nothing pending, true when the link is down, and true for a slow save", () => {
    const now = 100_000;
    expect(riskOfLoss({ state: "reconnecting", pendingCount: 0, oldestPendingAt: null, now })).toBe(false);
    expect(riskOfLoss({ state: "reconnecting", pendingCount: 1, oldestPendingAt: now, now })).toBe(true);
    expect(riskOfLoss({ state: "recovery-required", pendingCount: 1, oldestPendingAt: now, now })).toBe(true);
    expect(riskOfLoss({ state: "saving", pendingCount: 1, oldestPendingAt: now - SLOW_SAVE_MS + 1, now })).toBe(false);
    expect(riskOfLoss({ state: "saving", pendingCount: 1, oldestPendingAt: now - SLOW_SAVE_MS, now })).toBe(true);
  });
});

describe("statusText", () => {
  it("says Saved only when live, and names the risk when reload may lose a change", () => {
    expect(statusText({ connection: "live", pendingCount: 0, riskOfLoss: false }).label).toBe("Saved");
    for (const connection of CONNECTION_STATES.filter((c) => c !== "live")) {
      expect(statusText({ connection, pendingCount: 1, riskOfLoss: false }).label).not.toMatch(/Saved/);
    }
    expect(statusText({ connection: "saving", pendingCount: 2, riskOfLoss: false })).toMatchObject({ label: "Saving…", warn: false });
    const slow = statusText({ connection: "saving", pendingCount: 2, riskOfLoss: true });
    expect(slow).toMatchObject({ label: "2 unsaved changes", warn: true });
    expect(slow.detail).toMatch(/Reloading now would lose them/);
    const lost = statusText({ connection: "recovery-required", pendingCount: 1, riskOfLoss: true });
    expect(lost.label).toBe("Connection lost · 1 unsaved");
    expect(lost.detail).toMatch(/1 unsaved change\. Reloading now would lose it/);
    expect(statusText({ connection: "reconnecting", pendingCount: 0, riskOfLoss: false })).toMatchObject({ label: "Reconnecting…", warn: false });
    expect(statusText({ connection: "read-only", pendingCount: 0, riskOfLoss: false }).label).toBe("View only");
  });
});

describe("ConnectionAnnouncer", () => {
  function setup() {
    vi.useFakeTimers();
    const said = [];
    const a = new ConnectionAnnouncer((m) => said.push(m));
    const s = (connection, pendingCount = 0, risk = false) => a.update({ connection, pendingCount, riskOfLoss: risk });
    return { said, s };
  }

  it("is silent for live <-> saving and for a reconnect that is over quickly", () => {
    const { said, s } = setup();
    s("live");
    for (let i = 0; i < 5; i++) { s("saving", 1); s("live"); }
    s("reconnecting", 1, true);
    vi.advanceTimersByTime(ANNOUNCE_RECONNECT_AFTER_MS - 100);
    s("saving", 1);
    s("live");
    vi.advanceTimersByTime(5000);
    expect(said).toEqual([]);
    vi.useRealTimers();
  });

  it("announces a lasting reconnect once (not each retry) and the reconnection", () => {
    const { said, s } = setup();
    s("live");
    s("reconnecting", 2, true);
    vi.advanceTimersByTime(ANNOUNCE_RECONNECT_AFTER_MS + 10);
    s("reconnecting", 2, true);
    s("reconnecting", 3, true);
    vi.advanceTimersByTime(10_000);
    expect(said).toEqual(["Reconnecting. 2 unsaved changes will be sent once connected."]);
    s("saving", 3);
    expect(said.at(-1)).toBe("Reconnected. Saving 3 changes.");
    s("live");
    expect(said).toHaveLength(2);
    vi.useRealTimers();
  });

  it("announces recovery-required at once with the risk, and a slow save once", () => {
    const { said, s } = setup();
    s("live");
    s("reconnecting", 1, true);
    s("recovery-required", 1, true);
    expect(said).toEqual(["Connection lost. 1 unsaved change; reloading now would lose them."]);
    vi.advanceTimersByTime(10_000);
    expect(said).toHaveLength(1);
    s("live");
    expect(said.at(-1)).toBe("Reconnected. All changes saved.");
    s("saving", 2);
    s("saving", 2, true);
    s("saving", 2, true);
    expect(said.at(-1)).toMatch(/^Saving is taking longer than usual\. 2 unsaved changes/);
    expect(said).toHaveLength(3);
    vi.useRealTimers();
  });
});

describe("recoveryAction (interim reload policy)", () => {
  it("never reloads with unacknowledged changes before the terminal timeout", () => {
    expect(recoveryAction({ pendingCount: 0, heldForMs: 0, recentReloads: 0, maxReloads: 3 })).toBe("reload");
    expect(recoveryAction({ pendingCount: 1, heldForMs: 0, recentReloads: 0, maxReloads: 3 })).toBe("hold");
    expect(recoveryAction({ pendingCount: 1, heldForMs: TERMINAL_RECOVERY_MS - 1, recentReloads: 0, maxReloads: 3 })).toBe("hold");
    expect(recoveryAction({ pendingCount: 1, heldForMs: TERMINAL_RECOVERY_MS, recentReloads: 0, maxReloads: 3 })).toBe("reload");
    expect(recoveryAction({ pendingCount: 0, heldForMs: 0, recentReloads: 3, maxReloads: 3 })).toBe("stop");
    expect(recoveryAction({ pendingCount: 2, heldForMs: TERMINAL_RECOVERY_MS, recentReloads: 3, maxReloads: 3 })).toBe("stop");
  });
});
