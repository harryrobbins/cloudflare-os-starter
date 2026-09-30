// The in-call keyboard shortcuts: push-to-talk on a bare Space, and where Space is left alone.
import { afterEach, describe, expect, it } from "vitest";

import { IDLE_CALL } from "../../store/calls.js";
import { INITIAL_STATE, type ChatState } from "../../store/state.js";
import { callKeyHandlers, isBareSpace, spaceBelongsToTarget } from "./shortcuts.js";

afterEach(() => {
  document.body.replaceChildren();
});

function stubStore(audioEnabled: boolean) {
  const calls: string[] = [];
  const store = {
    state: { ...INITIAL_STATE, call: { ...IDLE_CALL, phase: "connected", audioEnabled } } as ChatState,
    pushToTalk(down: boolean) {
      calls.push(down ? "ptt-down" : "ptt-up");
      if (down && !store.state.call.audioEnabled) {
        store.state = { ...store.state, callPushToTalk: true, call: { ...store.state.call, audioEnabled: true } };
      } else if (!down && store.state.callPushToTalk) {
        store.state = { ...store.state, callPushToTalk: false, call: { ...store.state.call, audioEnabled: false } };
      }
    },
    toggleCallAudio() {
      calls.push("toggle-audio");
    },
    async toggleCallVideo() {
      calls.push("toggle-video");
    },
  };
  return { store, calls };
}

function key(type: "keydown" | "keyup", init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

const space = { key: " ", code: "Space" };

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

describe("isBareSpace", () => {
  it("takes Space alone and leaves chords to the browser", () => {
    expect(isBareSpace(key("keydown", space))).toBe(true);
    expect(isBareSpace(key("keydown", { ...space, shiftKey: true }))).toBe(false);
    expect(isBareSpace(key("keydown", { ...space, ctrlKey: true }))).toBe(false);
    expect(isBareSpace(key("keydown", { key: "d", code: "KeyD" }))).toBe(false);
  });
});

describe("spaceBelongsToTarget", () => {
  it("leaves Space to fields, buttons and widgets, and takes it on plain content", () => {
    document.body.innerHTML = `
      <textarea id="composer"></textarea><button id="mute"><span id="icon"></span></button>
      <div role="menuitem" id="item"></div><div contenteditable id="edit"></div>
      <div contenteditable="false" id="readonly"></div><div id="tile"></div>`;
    expect(spaceBelongsToTarget(byId("composer"))).toBe(true);
    expect(spaceBelongsToTarget(byId("icon"))).toBe(true);
    expect(spaceBelongsToTarget(byId("item"))).toBe(true);
    expect(spaceBelongsToTarget(byId("edit"))).toBe(true);
    expect(spaceBelongsToTarget(byId("readonly"))).toBe(false);
    expect(spaceBelongsToTarget(byId("tile"))).toBe(false);
    expect(spaceBelongsToTarget(null)).toBe(false);
  });
});

describe("callKeyHandlers", () => {
  it("holds Space to talk while muted, swallowing the repeats, and mutes on release", () => {
    const { store, calls } = stubStore(false);
    const keys = callKeyHandlers(store);
    const down = key("keydown", space);
    keys.onKeyDown(down);
    expect(down.defaultPrevented).toBe(true);
    const repeat = key("keydown", { ...space, repeat: true });
    keys.onKeyDown(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    keys.onKeyUp(key("keyup", space));
    expect(calls).toEqual(["ptt-down", "ptt-up"]);
    expect(store.state.call.audioEnabled).toBe(false);
  });

  it("does nothing on Space when the microphone is already on", () => {
    const { store, calls } = stubStore(true);
    const keys = callKeyHandlers(store);
    const down = key("keydown", space);
    keys.onKeyDown(down);
    keys.onKeyUp(key("keyup", space));
    expect(down.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it("leaves Space to a focused text field or button", () => {
    document.body.innerHTML = `<textarea></textarea><button></button>`;
    const { store, calls } = stubStore(false);
    const keys = callKeyHandlers(store);
    keys.onKeyDown(key("keydown", space, document.querySelector("textarea")!));
    keys.onKeyDown(key("keydown", space, document.querySelector("button")!));
    expect(calls).toEqual([]);
  });

  it("keeps Ctrl/Cmd+D and Ctrl/Cmd+E", () => {
    const { store, calls } = stubStore(true);
    const keys = callKeyHandlers(store);
    keys.onKeyDown(key("keydown", { key: "d", ctrlKey: true }));
    keys.onKeyDown(key("keydown", { key: "E", metaKey: true }));
    keys.onKeyDown(key("keydown", { key: "d", ctrlKey: true, shiftKey: true }));
    expect(calls).toEqual(["toggle-audio", "toggle-video"]);
  });
});
