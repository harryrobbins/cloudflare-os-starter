/**
 * Calls in the store: the pure rules in `calls.ts`, then the sequencing the store owns -- room state
 * from `hello`, the channel list and `call` events; forwarding into the engine; rings; `call-moved`;
 * the pane's state around a join; the shell's `chat:layout` and call-pill controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CallParticipant,
  CallState,
  Channel,
  ChannelListResponse,
  Membership,
  MeResponse,
  Message,
  ServerEvent,
  User,
} from "../contract.js";
import { CALL_REACTION_BURST } from "../contract.js";
import { ApiError, type ChatApi, type ChatSocket, type SocketStatus } from "../api/types.js";
import { createFakeCallEngine, type FakeCallEngine } from "../call/ui/fake-engine.js";
import { conversationKey } from "./drafts.js";
import {
  CALLS_DISABLED,
  IDLE_CALL,
  NO_CALL_UI,
  applyCallEvent,
  callBanner,
  callButtonState,
  callHref,
  callPaneFor,
  classifyCallFailure,
  connectionQualityLabel,
  dismissHeadphonesHint,
  headphonesHintDismissed,
  loadCallPrefs,
  looksLikeBuiltInSpeakers,
  pruneRings,
  saveCallPrefs,
  shouldHintHeadphones,
  shouldRing,
} from "./calls.js";
import { CALL_REACTION_SHOW_MS } from "./state.js";
import { ChatStore, RING_TIMEOUT_MS } from "./store.js";

const ENABLED = { enabled: true, maxParticipants: 5 };

function user(id: string, name: string): User {
  return { id, name, email: `${id}@example.test`, avatarKey: null, firstSeenAt: 0, lastSeenAt: 0, tz: null, online: true };
}
const me = user("me", "Harry Robbins");
const alice = user("alice", "Alice Chen");

function channel(id: string, kind: Channel["kind"] = "public"): Channel {
  return {
    id,
    kind,
    name: kind === "dm" ? null : id,
    topic: null,
    purpose: null,
    createdBy: "alice",
    createdAt: 0,
    archived: false,
    memberCount: 2,
    lastSeq: 1,
    ...(kind === "dm" || kind === "group" ? { memberIds: ["me", "alice"] } : {}),
  };
}

function membership(channelId: string, patch: Partial<Membership> = {}): Membership {
  return {
    channelId,
    userId: "me",
    joinedAt: 0,
    lastReadSeq: 1,
    manualUnreadSeq: null,
    notify: "all",
    muted: false,
    starred: false,
    ...patch,
  };
}

function participant(id: string, userId: string, patch: Partial<CallParticipant> = {}): CallParticipant {
  return { id, userId, sessionId: `s-${id}`, joinedAt: 0, audio: true, video: true, screen: false, tracks: [], ...patch };
}

function call(channelId: string, participants: CallParticipant[], patch: Partial<CallState> = {}): CallState {
  return {
    id: `call-${channelId}`,
    channelId,
    startedBy: participants[0]?.userId ?? "alice",
    startedAt: 1000,
    messageId: `m-${channelId}`,
    participants,
    ...patch,
  };
}

// --- pure rules --------------------------------------------------------------------------------

describe("applyCallEvent", () => {
  it("sets a conversation's call and removes it when it ends", () => {
    const running = call("c1", [participant("p1", "alice")]);
    const set = applyCallEvent({}, "c1", running);
    expect(set).toEqual({ c1: running });
    expect(applyCallEvent(set, "c1", null)).toEqual({});
  });

  it("keeps the same map when an unknown call ends", () => {
    const calls = {};
    expect(applyCallEvent(calls, "c9", null)).toBe(calls);
  });
});

describe("shouldRing", () => {
  const base = {
    ring: true,
    call: call("d1", [participant("p1", "alice")], { startedBy: "alice" }),
    meId: "me",
    membership: membership("d1"),
    localCallId: null,
  };

  it("rings for somebody else's start in a conversation I am in", () => {
    expect(shouldRing(base)).toBe(true);
  });

  it("never rings for my own start, even in the tab that did not start it", () => {
    expect(shouldRing({ ...base, call: { ...base.call, startedBy: "me" } })).toBe(false);
  });

  it("does not ring once I am in the call from any tab", () => {
    expect(shouldRing({ ...base, call: { ...base.call, participants: [...base.call.participants, participant("p2", "me")] } })).toBe(false);
    expect(shouldRing({ ...base, localCallId: base.call.id })).toBe(false);
  });

  it("is silenced by muting or 'nothing', and needs the server's ring flag", () => {
    expect(shouldRing({ ...base, membership: membership("d1", { muted: true }) })).toBe(false);
    expect(shouldRing({ ...base, membership: membership("d1", { notify: "none" }) })).toBe(false);
    expect(shouldRing({ ...base, membership: undefined })).toBe(false);
    expect(shouldRing({ ...base, ring: undefined })).toBe(false);
    expect(shouldRing({ ...base, call: null })).toBe(false);
  });
});

describe("pruneRings", () => {
  it("drops rings whose call ended or was replaced", () => {
    const ring = { callId: "call-d1", channelId: "d1", startedBy: "alice", at: 0 };
    expect(pruneRings([ring], { d1: call("d1", []) })).toEqual([ring]);
    expect(pruneRings([ring], {})).toEqual([]);
    expect(pruneRings([ring], { d1: call("d1", [], { id: "call-other" }) })).toEqual([]);
  });
});

describe("callButtonState", () => {
  const base = {
    feature: ENABLED,
    call: undefined as CallState | undefined,
    local: IDLE_CALL,
    channelId: "c1",
    meId: "me",
    member: true,
    archived: false,
  };

  it("is hidden when calls are off, for a non-member, and in an archived channel", () => {
    expect(callButtonState({ ...base, feature: CALLS_DISABLED }).kind).toBe("hidden");
    expect(callButtonState({ ...base, member: false }).kind).toBe("hidden");
    expect(callButtonState({ ...base, archived: true }).kind).toBe("hidden");
  });

  it("offers to start a call when none runs", () => {
    expect(callButtonState(base)).toEqual({ kind: "start" });
  });

  it("offers to join with the count and the first three faces", () => {
    const running = call("c1", ["a", "b", "c", "d"].map((id) => participant(`p-${id}`, id)));
    expect(callButtonState({ ...base, call: running })).toEqual({ kind: "join", count: 4, userIds: ["a", "b", "c"] });
  });

  it("says In call while this frame is in it, joining included", () => {
    const running = call("c1", [participant("p1", "alice")]);
    for (const phase of ["joining", "connected", "reconnecting"] as const) {
      expect(callButtonState({ ...base, call: running, local: { ...IDLE_CALL, phase, channelId: "c1" } }).kind).toBe("in-call");
    }
    // In a call somewhere else, this conversation's call is still joinable.
    expect(callButtonState({ ...base, call: running, local: { ...IDLE_CALL, phase: "connected", channelId: "c2" } }).kind).toBe("join");
  });

  it("is full at the cap of other people, but never locks me out of a call I am in elsewhere", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => participant(`p-${id}`, id));
    expect(callButtonState({ ...base, call: call("c1", five) })).toEqual({ kind: "full", max: 5 });
    const fourAndMe = [...five.slice(0, 4), participant("p-me", "me")];
    expect(callButtonState({ ...base, call: call("c1", fourAndMe) }).kind).toBe("join");
  });
});

describe("callPaneFor", () => {
  it("shows pre-join, then the engine's phase, only in the call's own conversation", () => {
    expect(callPaneFor("c1", IDLE_CALL, NO_CALL_UI)).toBe("none");
    expect(callPaneFor("c1", IDLE_CALL, { ...NO_CALL_UI, channelId: "c1", prejoin: true })).toBe("prejoin");
    expect(callPaneFor("c2", IDLE_CALL, { ...NO_CALL_UI, channelId: "c1", prejoin: true })).toBe("none");
    const connected = { ...IDLE_CALL, phase: "connected" as const, channelId: "c1" };
    expect(callPaneFor("c1", connected, NO_CALL_UI)).toBe("connected");
    expect(callPaneFor("c2", connected, NO_CALL_UI)).toBe("none");
  });

  it("keeps a failed or moved call up until it is dismissed", () => {
    const moved = { ...IDLE_CALL, phase: "moved" as const, channelId: "c1" };
    expect(callPaneFor("c1", moved, { ...NO_CALL_UI, channelId: "c1" })).toBe("moved");
    expect(callPaneFor("c1", moved, NO_CALL_UI)).toBe("none");
    expect(callPaneFor("c1", IDLE_CALL, { ...NO_CALL_UI, channelId: "c1", failure: { kind: "full", message: "x" } })).toBe("failed");
  });
});

describe("classifyCallFailure", () => {
  it("sorts server codes and media refusals", () => {
    expect(classifyCallFailure(new ApiError("conflict", "full", 409))).toEqual({ kind: "full", message: "This call is full (5)." });
    expect(classifyCallFailure(new ApiError("unavailable", "off", 503)).kind).toBe("unavailable");
    expect(classifyCallFailure(new DOMException("denied", "NotAllowedError")).kind).toBe("permission");
    expect(classifyCallFailure(new Error("SFU said no"))).toEqual({ kind: "error", message: "SFU said no" });
    expect(classifyCallFailure(new ApiError("forbidden", "archived", 403)).message).toMatch(/can't join/u);
    expect(classifyCallFailure(new ApiError("rate_limited", "slow", 429, 42)).message).toBe(
      "Too many attempts to join. Try again in 42 s.",
    );
  });
});

describe("call prefs", () => {
  afterEach(() => window.localStorage.clear());

  it("round-trips the devices and toggles, and survives garbage", () => {
    expect(loadCallPrefs()).toEqual({
      devices: { audioInputId: null, videoInputId: null, audioOutputId: null },
      start: { audio: true, video: true },
    });
    saveCallPrefs({ devices: { audioInputId: "mic-2", videoInputId: null, audioOutputId: "spk" }, start: { audio: false, video: true } });
    expect(loadCallPrefs()).toEqual({
      devices: { audioInputId: "mic-2", videoInputId: null, audioOutputId: "spk" },
      start: { audio: false, video: true },
    });
    window.localStorage.setItem("chat.call", "{not json");
    expect(loadCallPrefs().start).toEqual({ audio: true, video: true });
  });
});

// --- the store -------------------------------------------------------------------------------

class FakeSocket implements ChatSocket {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(event: ServerEvent) => void>();
  open(): void {}
  close(): void {}
  send(event: unknown): void {
    this.sent.push(event);
  }
  status(): SocketStatus {
    return "open";
  }
  retryInSeconds(): number | null {
    return null;
  }
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onStatus(): () => void {
    return () => undefined;
  }
  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

interface Harness {
  store: ChatStore;
  socket: FakeSocket;
  engine: FakeCallEngine;
}

const seeded = call("c1", [participant("p-alice", "alice")]);

async function started(options: { calls?: CallState[]; embedded?: boolean } = {}): Promise<Harness> {
  const socket = new FakeSocket();
  const engine = createFakeCallEngine();
  const api = {
    me: async (): Promise<MeResponse> => ({
      user: me,
      prefs: { displayName: null, tz: null, notify: "all" },
      admin: false,
      agent: { replies: "enabled" },
      badges: { unread: {}, mentions: {}, threads: 0 },
      limits: { maxBodyBytes: 8192, maxUploadBytes: 1024, maxAttachmentsPerMessage: 10 },
      protocolVersion: 1,
      calls: ENABLED,
    }),
    listChannels: async (): Promise<ChannelListResponse> => ({
      channels: [channel("c1"), channel("d1", "dm")],
      memberships: [membership("c1"), membership("d1")],
      users: [me, alice],
      badges: { unread: {}, mentions: {}, threads: 0 },
      calls: options.calls ?? [seeded],
    }),
    listThreads: async () => ({ threads: [], users: [], cursor: null }),
    listMessages: async () => ({
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      users: [],
      channelLastSeq: 1,
    }),
    getUsers: async () => ({ users: [], cursor: null }),
  } as unknown as ChatApi;
  const store = new ChatStore({ transport: { api, socket }, navigate: () => undefined, callEngine: engine });
  await store.start({ embedded: options.embedded ?? false });
  return { store, socket, engine };
}

let current: Harness | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
  vi.useRealTimers();
  window.localStorage.clear();
});

async function harness(options?: Parameters<typeof started>[0]): Promise<Harness> {
  current = await started(options);
  return current;
}

describe("the store's room state", () => {
  it("takes the feature flag from /api/me and the active calls from the channel list", async () => {
    const { store } = await harness();
    expect(store.state.callFeature).toEqual(ENABLED);
    expect(store.state.calls).toEqual({ c1: seeded });
  });

  it("replaces the calls from hello, dropping one that ended while disconnected", async () => {
    const { store, socket } = await harness();
    socket.emit({ t: "hello", user: me, sessionId: "s", serverTime: 0, protocolVersion: 1, lastSeq: {}, calls: [] });
    expect(store.state.calls).toEqual({});
  });

  it("applies call events, and forwards only the joined conversation's to the engine", async () => {
    const { store, socket, engine } = await harness();
    await store.joinCall("c1");
    engine.set({ callId: seeded.id });
    engine.applied.length = 0;

    const withMe = call("c1", [participant("p-alice", "alice"), participant("p-me", "me")]);
    socket.emit({ t: "call", channel: "c1", call: withMe });
    socket.emit({ t: "call", channel: "c2", call: call("c2", [participant("p-x", "alice")]) });
    expect(store.state.calls.c1).toEqual(withMe);
    expect(store.state.calls.c2).toBeDefined();
    expect(engine.applied).toEqual([withMe]);

    // The call ended under this connected frame: the engine is told to leave, not just to stop pulling.
    socket.emit({ t: "call", channel: "c1", call: null });
    expect(store.state.calls.c1).toBeUndefined();
    await Promise.resolve();
    expect(engine.left).toBe(1);
    expect(store.state.call.phase).toBe("idle");
    expect(store.state.announcement).toBe("The call ended");
  });

  it("leaves when hello no longer lists the joined call", async () => {
    const { store, socket, engine } = await harness();
    await store.joinCall("c1");
    engine.set({ callId: seeded.id });
    socket.emit({ t: "hello", user: me, sessionId: "s", serverTime: 0, protocolVersion: 1, lastSeq: {}, calls: [] });
    await Promise.resolve();
    expect(engine.left).toBe(1);
  });

  it("does not treat a cancelled join as a failure", async () => {
    const { store, engine } = await harness();
    engine.failNextJoin = new Error("The join was cancelled.");
    await store.joinCall("c1");
    expect(store.state.callUi.failure).toBeNull();
  });

  it("hands the engine the latest room once its join resolves", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    expect(engine.applied).toContainEqual(seeded);
  });

  it("passes call-moved to the engine", async () => {
    const { socket, engine } = await harness();
    socket.emit({ t: "call-moved", call: "call-c1", participant: "p-me", reason: "replaced" });
    expect(engine.moved).toEqual([["call-c1", "p-me"]]);
  });

  it("merges an ended call's edited message through the ordinary edit path", async () => {
    const { store, socket } = await harness();
    await store.openConversation("c1");
    const started: Message = {
      id: "m-c1",
      channelId: "c1",
      seq: 2,
      rootId: null,
      authorId: "alice",
      body: "Alice Chen started a call",
      kind: "system",
      createdAt: 1000,
      editedAt: null,
      deletedAt: null,
      replyCount: 0,
      lastReplyAt: null,
      reactions: [],
      attachments: [],
      mentions: [],
      call: { id: "call-c1", state: "active", startedAt: 1000, endedAt: null, participantIds: ["alice"] },
    };
    socket.emit({ t: "msg", message: started });
    socket.emit({
      t: "edit",
      message: { ...started, call: { ...started.call!, state: "ended", endedAt: 1000 + 23 * 60_000, participantIds: ["alice", "me"] } },
    });
    const row = store.state.conversations[conversationKey("c1")]!.messages.find((message) => message.id === "m-c1");
    expect(row?.call?.state).toBe("ended");
    expect(row?.call?.participantIds).toEqual(["alice", "me"]);
  });
});

describe("rings", () => {
  const ringing = call("d1", [participant("p-alice", "alice")], { startedBy: "alice" });

  it("rings for a dm call, and stops after thirty seconds", async () => {
    const { store, socket } = await harness({ calls: [] });
    vi.useFakeTimers();
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    expect(store.state.rings).toHaveLength(1);
    expect(store.state.rings[0]).toMatchObject({ callId: ringing.id, channelId: "d1", startedBy: "alice" });
    // The same call announced twice rings once.
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    expect(store.state.rings).toHaveLength(1);
    vi.advanceTimersByTime(RING_TIMEOUT_MS + 10);
    expect(store.state.rings).toHaveLength(0);
  });

  it("stops ringing when the call ends", async () => {
    const { store, socket } = await harness({ calls: [] });
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    socket.emit({ t: "call", channel: "d1", call: null });
    expect(store.state.rings).toHaveLength(0);
  });

  it("never rings for my own start or without the server's flag", async () => {
    const { store, socket } = await harness({ calls: [] });
    socket.emit({ t: "call", channel: "d1", call: { ...ringing, startedBy: "me" }, ring: true });
    socket.emit({ t: "call", channel: "c1", call: seeded });
    expect(store.state.rings).toHaveLength(0);
  });

  it("goes to the shell's notification when the dock is hidden", async () => {
    const { store, socket } = await harness({ calls: [], embedded: true });
    const notify = vi.fn();
    store.onNotify = notify;
    store.setVisible(false);
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    expect(notify).toHaveBeenCalledWith("Alice Chen is calling", "Video call", callHref("d1"));
  });

  it("does not notify the shell while the dock is on screen", async () => {
    const { store, socket } = await harness({ calls: [], embedded: true });
    const notify = vi.fn();
    store.onNotify = notify;
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    expect(notify).not.toHaveBeenCalled();
    expect(store.state.rings).toHaveLength(1);
  });

  it("does not also toast the call's system message as a new message", async () => {
    const { store, socket } = await harness({ calls: [] });
    socket.emit({
      t: "msg",
      message: {
        id: "m-d1",
        channelId: "d1",
        seq: 2,
        rootId: null,
        authorId: "alice",
        body: "Alice Chen started a call",
        kind: "system",
        createdAt: 1,
        editedAt: null,
        deletedAt: null,
        replyCount: 0,
        lastReplyAt: null,
        reactions: [],
        attachments: [],
        mentions: [],
        call: { id: ringing.id, state: "active", startedAt: 1, endedAt: null, participantIds: ["alice"] },
      },
    });
    expect(store.state.toasts).toHaveLength(0);
  });

  it("is dismissed by joining the call it rang for", async () => {
    const { store, socket, engine } = await harness({ calls: [] });
    socket.emit({ t: "call", channel: "d1", call: ringing, ring: true });
    engine.set({ phase: "connected", channelId: "d1", callId: ringing.id, participantId: "p-me" });
    expect(store.state.rings).toHaveLength(0);
  });
});

describe("joining and leaving", () => {
  it("joins with the remembered toggles and devices", async () => {
    const { store, engine } = await harness();
    store.setCallStart({ video: false });
    void store.setCallDevices({ audioInputId: "mic-2" });
    store.openCallPrejoin("c1");
    expect(store.state.callUi).toMatchObject({ channelId: "c1", prejoin: true });
    await store.joinCall("c1");
    expect(engine.joins).toEqual([
      { channelId: "c1", audio: true, video: false, devices: { audioInputId: "mic-2", videoInputId: null, audioOutputId: null } },
    ]);
    expect(store.state.call.phase).toBe("connected");
    expect(store.state.callUi.prejoin).toBe(false);
  });

  it("explains a full call", async () => {
    const { store, engine } = await harness();
    engine.failNextJoin = new ApiError("conflict", "The call is full.", 409);
    await store.joinCall("c1");
    expect(store.state.callUi.failure).toEqual({ kind: "full", message: "This call is full (5)." });
    expect(callPaneFor("c1", store.state.call, store.state.callUi)).toBe("failed");
    // Close clears the pane and the engine's terminal state.
    store.closeCallPane();
    expect(store.state.callUi).toEqual(NO_CALL_UI);
    expect(engine.left).toBe(1);
  });

  it("tells the shell when this frame joins, mutes and leaves, once per change", async () => {
    const { store, engine } = await harness();
    const changes: unknown[] = [];
    store.onCallChange = (call) => changes.push(call);
    await store.joinCall("c1");
    // Muting is re-sent for the shell's pill; an unrelated snapshot change is not.
    store.toggleCallAudio();
    engine.set({ localAudioLevel: 0.4 });
    await store.leaveCall();
    const href = callHref("c1");
    expect(changes).toEqual([
      // Joining: the frame is pinned before the devices are open.
      { active: true, href, audio: false, video: false },
      { active: true, href, audio: true, video: true },
      { active: true, href, audio: false, video: true },
      { active: false },
    ]);
  });

  it("announces mute and camera changes", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    store.toggleCallAudio();
    expect(engine.audio).toEqual([false]);
    expect(store.state.announcement).toBe("Microphone off");
    await store.toggleCallVideo();
    expect(engine.video).toEqual([false]);
    expect(store.state.announcement).toBe("Camera off");
  });

  it("push-to-talk unmutes while held and mutes on release, announcing both", async () => {
    const { store, engine } = await harness();
    store.setCallStart({ audio: false });
    await store.joinCall("c1");
    store.pushToTalk(true);
    expect(store.state.callPushToTalk).toBe(true);
    expect(store.state.announcement).toBe("Talking. Release Space to mute");
    // A second press while held is ignored.
    store.pushToTalk(true);
    store.pushToTalk(false);
    expect(engine.audio).toEqual([true, false]);
    expect(store.state.callPushToTalk).toBe(false);
    expect(store.state.announcement).toBe("Microphone off");
    // A release without a press does nothing.
    store.pushToTalk(false);
    expect(engine.audio).toEqual([true, false]);
  });

  it("push-to-talk never mutes a microphone that was on, and a toggle while held sticks", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    store.pushToTalk(true);
    expect(engine.audio).toEqual([]);
    store.toggleCallAudio(); // mute
    store.toggleCallAudio(); // unmute on purpose
    engine.audio.length = 0;
    // Held from muted, then clicked: the click wins and the release leaves the microphone alone.
    store.toggleCallAudio(); // mute
    store.pushToTalk(true);
    store.toggleCallAudio(); // deliberate: mic off while holding
    store.pushToTalk(false);
    expect(engine.audio).toEqual([false, true, false]);
    expect(store.state.callPushToTalk).toBe(false);
  });

  it("push-to-talk ends with the call", async () => {
    const { store } = await harness();
    store.setCallStart({ audio: false });
    await store.joinCall("c1");
    store.pushToTalk(true);
    await store.leaveCall();
    expect(store.state.callPushToTalk).toBe(false);
  });

  it("toggles chosen audio-only through the engine and announces it", async () => {
    const { store, engine } = await harness();
    await store.toggleCallAudioOnly(); // not in a call: nothing
    expect(engine.audioOnly).toEqual([]);
    await store.joinCall("c1");
    await store.toggleCallAudioOnly();
    expect(store.state.call.audioOnlyChosen).toBe(true);
    expect(store.state.announcement).toBe("Audio only: video is paused");
    await store.toggleCallAudioOnly();
    expect(engine.audioOnly).toEqual([true, false]);
    expect(store.state.announcement).toBe("Video is back on");
  });

  it("disposes the engine on unload without leaving", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    store.disposeCall();
    expect(engine.disposed).toBe(1);
    expect(engine.left).toBe(0);
  });
});

describe("raised hands and reactions", () => {
  async function inCall(): Promise<Harness & { room: (patch?: Partial<CallParticipant>, alicePatch?: Partial<CallParticipant>) => CallState }> {
    const h = await harness();
    await h.store.joinCall("c1");
    const room = (mine: Partial<CallParticipant> = {}, theirs: Partial<CallParticipant> = {}): CallState =>
      call("c1", [participant("p-alice", "alice", theirs), participant("p-me", me.id, mine)], { id: "call-1" });
    h.socket.emit({ t: "call", channel: "c1", call: room() });
    return { ...h, room };
  }

  it("raises and lowers this person's hand over the socket, once per change", async () => {
    const { store, socket, room } = await inCall();
    store.toggleCallHand();
    expect(socket.sent.at(-1)).toEqual({ t: "call-hand", call: "call-1", participant: "p-me", raised: true });
    expect(store.state.announcement).toBe("You raised your hand");
    socket.emit({ t: "call", channel: "c1", call: room({ hand: 5 }) });
    const sent = socket.sent.length;
    store.setCallHand(true); // already up
    expect(socket.sent).toHaveLength(sent);
    store.toggleCallHand();
    expect(socket.sent.at(-1)).toMatchObject({ t: "call-hand", raised: false });
  });

  it("announces somebody else raising their hand, once", async () => {
    const { store, socket, room } = await inCall();
    store.announce("");
    socket.emit({ t: "call", channel: "c1", call: room({}, { hand: 7 }) });
    expect(store.state.announcement).toBe("Alice Chen raised their hand");
    store.announce("");
    socket.emit({ t: "call", channel: "c1", call: room({ audio: false }, { hand: 7 }) });
    expect(store.state.announcement).toBe("");
  });

  it("shows reactions for this call for a few seconds, and keeps inside the burst", async () => {
    vi.useFakeTimers();
    const { store, socket } = await inCall();
    socket.emit({ t: "call-react", channel: "c1", call: "call-1", participant: "p-alice", emoji: "🎉" });
    socket.emit({ t: "call-react", channel: "c9", call: "call-other", participant: "p-x", emoji: "👍" });
    expect(store.state.callReactions).toEqual([{ id: expect.any(Number), participantId: "p-alice", emoji: "🎉" }]);
    expect(store.state.announcement).toBe("Alice Chen reacted 🎉");
    vi.advanceTimersByTime(CALL_REACTION_SHOW_MS + 10);
    expect(store.state.callReactions).toEqual([]);

    const before = socket.sent.length;
    for (let i = 0; i < CALL_REACTION_BURST + 2; i += 1) store.sendCallReaction("👍");
    expect(socket.sent.slice(before)).toHaveLength(CALL_REACTION_BURST);
    expect(socket.sent.at(-1)).toEqual({ t: "call-react", call: "call-1", participant: "p-me", emoji: "👍" });
  });

  it("clears reactions when the call ends", async () => {
    const { store, socket } = await inCall();
    socket.emit({ t: "call-react", channel: "c1", call: "call-1", participant: "p-alice", emoji: "👏" });
    await store.leaveCall();
    expect(store.state.callReactions).toEqual([]);
  });
});

describe("the shell's layout and call pill", () => {
  it("switches between the full page and the dock at runtime, without touching the call", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    store.setCallFocus(true);
    store.setLayout("dock");
    expect(store.state.compact).toBe(true);
    expect(store.state.shellLayout).toBe("dock");
    expect(store.state.callUi.chatOpen).toBe(true);
    // The sidebar has no Focus: the rail is not shown there anyway.
    expect(store.state.callFocus).toBe(false);
    expect(document.documentElement.dataset.compact).toBe("1");

    store.setLayout("hidden");
    expect(store.state.compact).toBe(true);
    expect(store.state.shellLayout).toBe("hidden");

    store.setLayout("page");
    expect(store.state.compact).toBe(false);
    expect(store.state.callUi.chatOpen).toBe(false);
    expect(document.documentElement.dataset.compact).toBeUndefined();

    expect(engine.joins).toHaveLength(1);
    expect(engine.left).toBe(0);
    expect(store.state.call.phase).toBe("connected");
  });

  it("drives the engine from the pill's controls", async () => {
    const { store, engine } = await harness();
    await store.joinCall("c1");
    store.callControl("toggle-audio");
    store.callControl("toggle-video");
    await Promise.resolve();
    expect(engine.audio).toEqual([false]);
    expect(engine.video).toEqual([false]);
    store.callControl("leave");
    await Promise.resolve();
    expect(engine.left).toBe(1);
  });

  it("asks the shell to move the call", async () => {
    const { store } = await harness();
    const present = vi.fn();
    store.onPresent = present;
    store.presentCall("dock");
    expect(present).toHaveBeenCalledWith("dock");
  });
});

describe("call quality rules", () => {
  it("labels good, fair and poor, and shows nothing for unknown or absent", () => {
    expect(connectionQualityLabel("good")).toBe("Connection: good");
    expect(connectionQualityLabel("fair")).toBe("Connection: fair");
    expect(connectionQualityLabel("poor")).toBe("Connection: poor");
    expect(connectionQualityLabel("unknown")).toBeNull();
    expect(connectionQualityLabel(undefined)).toBeNull();
  });

  const connected = { ...IDLE_CALL, phase: "connected" as const };

  it("shows no banner when nothing is wrong, the fields are absent, or the call is not connected", () => {
    expect(callBanner(connected)).toBeNull();
    expect(callBanner({ ...connected, localQuality: "fair", limitation: "bandwidth", audioOnly: false })).toBeNull();
    expect(callBanner({ ...connected, phase: "reconnecting", audioOnly: true })).toBeNull();
  });

  it("puts audio-only first, then a poor uplink, then a CPU limit", () => {
    const all = { ...connected, audioOnly: true, localQuality: "poor" as const, limitation: "cpu" as const };
    expect(callBanner(all)?.kind).toBe("audio-only");
    expect(callBanner(all)?.message).toBe("Your connection is unstable — video paused to keep audio clear");
    expect(callBanner({ ...all, audioOnly: false })).toEqual({ kind: "unstable", message: "Your connection is unstable" });
    expect(callBanner({ ...connected, limitation: "cpu" })).toEqual({
      kind: "cpu",
      message: "Your computer is struggling — sending lower video quality",
    });
  });

  it("respects dismissals, and dismissing audio-only also silences the plain unstable banner", () => {
    const all = { ...connected, audioOnly: true, localQuality: "poor" as const, limitation: "cpu" as const };
    expect(callBanner(all, new Set(["audio-only"]))?.kind).toBe("cpu");
    expect(callBanner({ ...all, limitation: "none" }, new Set(["audio-only"]))).toBeNull();
    expect(callBanner({ ...all, audioOnly: false }, new Set(["unstable"]))?.kind).toBe("cpu");
    expect(callBanner(all, new Set(["audio-only", "cpu"]))).toBeNull();
  });

  it("recognises built-in speakers by label, never headphones or a blank label", () => {
    expect(looksLikeBuiltInSpeakers("MacBook Pro Speakers (Built-in)")).toBe(true);
    expect(looksLikeBuiltInSpeakers("Speakers (Realtek(R) Audio)")).toBe(true);
    expect(looksLikeBuiltInSpeakers("Internal Audio Analog Stereo")).toBe(true);
    expect(looksLikeBuiltInSpeakers("Default - MacBook Air Speakers")).toBe(true);
    expect(looksLikeBuiltInSpeakers("Headphones (Built-in)")).toBe(false);
    expect(looksLikeBuiltInSpeakers("Jabra Evolve2 Headset")).toBe(false);
    expect(looksLikeBuiltInSpeakers("Harry's AirPods Pro")).toBe(false);
    expect(looksLikeBuiltInSpeakers("Galaxy Buds2 speaker")).toBe(false);
    expect(looksLikeBuiltInSpeakers("HDMI Output")).toBe(false);
    expect(looksLikeBuiltInSpeakers("")).toBe(false);
    expect(looksLikeBuiltInSpeakers(undefined)).toBe(false);
  });

  it("hints headphones only with two or more others on labelled built-in speakers", () => {
    const outputs = [
      { deviceId: "default", label: "Default - MacBook Pro Speakers (Built-in)" },
      { deviceId: "spk", label: "MacBook Pro Speakers (Built-in)" },
      { deviceId: "hp", label: "AirPods Pro" },
    ];
    expect(shouldHintHeadphones({ others: 2, outputId: "spk", outputs })).toBe(true);
    expect(shouldHintHeadphones({ others: 2, outputId: null, outputs })).toBe(true);
    expect(shouldHintHeadphones({ others: 1, outputId: "spk", outputs })).toBe(false);
    expect(shouldHintHeadphones({ others: 3, outputId: "hp", outputs })).toBe(false);
    // Labels unavailable (no permission yet): the default device proves nothing.
    expect(shouldHintHeadphones({ others: 3, outputId: null, outputs: [{ deviceId: "default", label: "" }] })).toBe(false);
    expect(shouldHintHeadphones({ others: 3, outputId: null, outputs: [] })).toBe(false);
    // A remembered device that has gone away is not evidence either.
    expect(shouldHintHeadphones({ others: 3, outputId: "gone", outputs })).toBe(false);
  });

  it("remembers the headphones tip's dismissal", () => {
    window.localStorage.removeItem("chat.call.headphonesHint");
    expect(headphonesHintDismissed()).toBe(false);
    dismissHeadphonesHint();
    expect(headphonesHintDismissed()).toBe(true);
    window.localStorage.removeItem("chat.call.headphonesHint");
  });
});
