// A thin, typed client for the Cloudflare Realtime SFU's HTTPS control API
// (docs/research/chat-video-sfu.md, "HTTP API").
//
// The SFU is sessions and tracks and nothing else; who may touch which session is decided in
// `calls.ts` before anything here runs. What this file owns:
//
//   * **The secret.** The app secret is only ever a Bearer header on a request to
//     `rtc.live.cloudflare.com`. It never reaches a response body or a log line.
//   * **Errors.** The SFU reports failures three ways: an HTTP status, a top-level `errorCode`, and a
//     per-item `errorCode` inside a 200. All three become an {@link SfuError} or, for per-item
//     failures the caller wants to see (pull), a field on the returned item -- never a silent success.
//   * **Retries, only where they are safe.** Creating a session (a spare one just expires), updating
//     a pulled track's layer, forced closes and inspection are retried with backoff on network
//     errors, timeouts, 429, 5xx and the SFU's transient codes. `tracks/new`, `renegotiate` and a
//     negotiated close are never retried blind: a duplicate allocates twice, and a lost outcome means
//     the client must rebuild its connection (the research note's gotcha 3).
//   * **Redacted logs.** Session ids are hashed; SDP is never logged.

import type { CallSimulcastRid, SessionDescription } from "../shared/protocol.js";
import { hashId, logEvent } from "./logs.js";

const SFU_BASE = "https://rtc.live.cloudflare.com/v1/apps";
/** Per attempt. video-room's Worker uses the same bound. */
const SFU_TIMEOUT_MS = 10_000;
/** Delays before the second and third attempt of a retry-safe operation. */
const RETRY_DELAYS_MS = [200, 600] as const;

/** SFU `errorCode`s the research note says to retry with backoff. */
const TRANSIENT_CODES = new Set([
  "retryable_transient_error",
  "temporarily_unavailable_error",
  "transport_unavailable_error",
  "backend_error",
  "internal_error",
]);

/** Everything `calls.ts` needs to reach Realtime. Built from the env, or injected by a test. */
export interface RealtimeConfig {
  readonly sfuAppId: string;
  readonly sfuAppSecret: string;
  /** Both null means STUN only (src/do/turn.ts). */
  readonly turnKeyId: string | null;
  readonly turnKeyApiToken: string | null;
  /** Injectable so tests run against a fake; production passes the global `fetch`. */
  readonly fetch: typeof fetch;
}

/**
 * The deployment's Realtime configuration, or null when calls are switched off.
 *
 * The kill switch is "no SFU credentials": both the app id and its secret must be non-empty. TURN is
 * optional and only counts when both of its halves are present.
 */
export function realtimeFromEnv(
  env: {
    readonly REALTIME_SFU_APP_ID?: string;
    readonly REALTIME_SFU_APP_SECRET?: string;
    readonly REALTIME_TURN_KEY_ID?: string;
    readonly REALTIME_TURN_KEY_API_TOKEN?: string;
  },
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): RealtimeConfig | null {
  const appId = nonEmpty(env.REALTIME_SFU_APP_ID);
  const secret = nonEmpty(env.REALTIME_SFU_APP_SECRET);
  if (appId === null || secret === null) return null;
  const turnKeyId = nonEmpty(env.REALTIME_TURN_KEY_ID);
  const turnToken = nonEmpty(env.REALTIME_TURN_KEY_API_TOKEN);
  const turn = turnKeyId !== null && turnToken !== null;
  return {
    sfuAppId: appId,
    sfuAppSecret: secret,
    turnKeyId: turn ? turnKeyId : null,
    turnKeyApiToken: turn ? turnToken : null,
    fetch: fetchImpl,
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * One authenticated JSON request to `rtc.live.cloudflare.com` (the SFU or the TURN key API), bounded
 * by `timeoutMs`. A request that never got a response comes back as `timeout` or `network`, so both
 * callers log the two the same way; a response of any status is the caller's to judge.
 */
export async function realtimeFetch(
  config: Pick<RealtimeConfig, "fetch">,
  url: string,
  init: { readonly method: string; readonly token: string; readonly body?: unknown; readonly timeoutMs: number },
): Promise<{ readonly response: Response } | { readonly response: null; readonly code: "timeout" | "network" }> {
  try {
    const response = await config.fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    return { response };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { response: null, code: timedOut ? "timeout" : "network" };
  }
}

/** A failed SFU operation. `code` is the SFU's `errorCode`, or `http_<status>` / `network` / `timeout`. */
export class SfuError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`SFU ${op} failed: ${code}`);
    this.name = "SfuError";
  }
}

export interface LocalTrack {
  readonly mid: string;
  readonly trackName: string;
}

export interface RemoteTrack {
  /** The publisher's session, always from the object's own rows. */
  readonly sessionId: string;
  readonly trackName: string;
  /** Present for a simulcast track: the preferred layer, with automatic step-down enabled. */
  readonly preferredRid?: CallSimulcastRid;
}

export interface PublishResult {
  readonly answer: SessionDescription;
  readonly tracks: readonly { readonly mid: string; readonly trackName: string }[];
}

export interface PullResult {
  readonly offer: SessionDescription | null;
  readonly requiresImmediateRenegotiation: boolean;
  /** In request order. */
  readonly tracks: readonly { readonly mid: string | null; readonly error?: string }[];
}

/** One SFU app, bound to a {@link RealtimeConfig}. */
export interface SfuClient {
  newSession(): Promise<string>;
  publish(sessionId: string, offer: SessionDescription, tracks: readonly LocalTrack[]): Promise<PublishResult>;
  pull(sessionId: string, tracks: readonly RemoteTrack[]): Promise<PullResult>;
  renegotiate(sessionId: string, answer: SessionDescription): Promise<void>;
  /** Negotiated close: the client's offer (with the transceivers stopped) in, the SFU's answer out. */
  closeNegotiated(sessionId: string, mids: readonly string[], offer: SessionDescription): Promise<SessionDescription | null>;
  /** Forced close, for cleanup. "Already closed" counts as success. */
  closeForced(sessionId: string, mids: readonly string[]): Promise<void>;
  setLayer(sessionId: string, mid: string, track: RemoteTrack & { readonly preferredRid: CallSimulcastRid }): Promise<void>;
}

/** The pull-side simulcast options: prefer this layer, step down a-to-z under pressure. */
export function simulcastOptions(preferredRid: CallSimulcastRid) {
  return { preferredRid, priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" } as const;
}

type Json = Record<string, unknown>;

interface Attempt {
  readonly op: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly body?: unknown;
  readonly session?: string;
  /** True only for operations a duplicate cannot harm. */
  readonly retry: boolean;
  /** Statuses that mean "already done" for this operation (a close of something gone). */
  readonly goneOk?: boolean;
}

export function sfuClient(config: RealtimeConfig): SfuClient {
  const base = `${SFU_BASE}/${encodeURIComponent(config.sfuAppId)}`;

  async function once(attempt: Attempt): Promise<{ status: number; body: Json }> {
    const started = Date.now();
    const sent = await realtimeFetch(config, `${base}${attempt.path}`, {
      method: attempt.method,
      token: config.sfuAppSecret,
      body: attempt.body,
      timeoutMs: SFU_TIMEOUT_MS,
    });
    if (sent.response === null) {
      log(attempt, 0, sent.code, started);
      throw new SfuError(attempt.op, 0, sent.code);
    }
    const response = sent.response;
    let body: Json = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Json;
    } catch {
      // An empty or non-JSON body; the status decides.
    }
    const topCode = typeof body["errorCode"] === "string" ? body["errorCode"] : null;
    if (attempt.goneOk === true && (response.status === 404 || response.status === 410)) {
      log(attempt, response.status, "gone", started);
      return { status: response.status, body: {} };
    }
    if (!response.ok || topCode !== null) {
      const code = topCode ?? `http_${response.status}`;
      log(attempt, response.status, code, started);
      throw new SfuError(attempt.op, response.status, code);
    }
    log(attempt, response.status, "ok", started);
    return { status: response.status, body };
  }

  async function call(attempt: Attempt): Promise<Json> {
    for (let index = 0; ; index++) {
      try {
        return (await once(attempt)).body;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[index];
        if (!attempt.retry || delay === undefined || !(error instanceof SfuError) || !retryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const session = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

  return {
    async newSession() {
      const body = await call({ op: "sessions/new", method: "POST", path: "/sessions/new", retry: true });
      const sessionId = body["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new SfuError("sessions/new", 200, "no_session_id");
      }
      return sessionId;
    },

    async publish(sessionId, offer, tracks) {
      const body = await call({
        op: "tracks/new:local",
        method: "POST",
        path: `${session(sessionId)}/tracks/new`,
        session: sessionId,
        retry: false,
        body: {
          sessionDescription: { type: offer.type, sdp: offer.sdp },
          tracks: tracks.map((track) => ({ location: "local", mid: track.mid, trackName: track.trackName })),
        },
      });
      const items = itemsOf(body);
      // A 200 can still carry failed items; a publish is all or nothing for the caller.
      const failed = items.find((item) => typeof item["errorCode"] === "string");
      if (failed !== undefined) throw new SfuError("tracks/new:local", 200, String(failed["errorCode"]));
      const answer = descriptionOf(body);
      if (answer === null || answer.type !== "answer") throw new SfuError("tracks/new:local", 200, "no_answer");
      return {
        answer,
        tracks: items.map((item, index) => ({
          mid: typeof item["mid"] === "string" ? item["mid"] : tracks[index]?.mid ?? "",
          trackName: typeof item["trackName"] === "string" ? item["trackName"] : tracks[index]?.trackName ?? "",
        })),
      };
    },

    async pull(sessionId, tracks) {
      const body = await call({
        op: "tracks/new:remote",
        method: "POST",
        path: `${session(sessionId)}/tracks/new`,
        session: sessionId,
        retry: false,
        body: {
          tracks: tracks.map((track) => ({
            location: "remote",
            sessionId: track.sessionId,
            trackName: track.trackName,
            ...(track.preferredRid === undefined ? {} : { simulcast: simulcastOptions(track.preferredRid) }),
          })),
        },
      });
      const items = itemsOf(body);
      const offer = descriptionOf(body);
      return {
        offer: offer !== null && offer.type === "offer" ? offer : null,
        requiresImmediateRenegotiation: body["requiresImmediateRenegotiation"] === true,
        tracks: tracks.map((track, index) => {
          // Matched by name first; the SFU answers in request order, which is the fallback.
          const item =
            items.find((candidate) => candidate["sessionId"] === track.sessionId && candidate["trackName"] === track.trackName) ??
            items[index];
          if (item === undefined) return { mid: null, error: "missing_track" };
          const error = typeof item["errorCode"] === "string" ? item["errorCode"] : undefined;
          const mid = typeof item["mid"] === "string" && error === undefined ? item["mid"] : null;
          return error === undefined ? { mid } : { mid, error };
        }),
      };
    },

    async renegotiate(sessionId, answer) {
      await call({
        op: "renegotiate",
        method: "PUT",
        path: `${session(sessionId)}/renegotiate`,
        session: sessionId,
        retry: false,
        body: { sessionDescription: { type: answer.type, sdp: answer.sdp } },
      });
    },

    async closeNegotiated(sessionId, mids, offer) {
      const body = await call({
        op: "tracks/close",
        method: "PUT",
        path: `${session(sessionId)}/tracks/close`,
        session: sessionId,
        retry: false,
        body: { tracks: mids.map((mid) => ({ mid })), sessionDescription: { type: offer.type, sdp: offer.sdp }, force: false },
      });
      // Per-item `close_track_error` means "already closed"; the answer must be applied regardless.
      const answer = descriptionOf(body);
      return answer !== null && answer.type === "answer" ? answer : null;
    },

    async closeForced(sessionId, mids) {
      if (mids.length === 0) return;
      try {
        await call({
          op: "tracks/close:force",
          method: "PUT",
          path: `${session(sessionId)}/tracks/close`,
          session: sessionId,
          retry: true,
          goneOk: true,
          body: { tracks: mids.map((mid) => ({ mid })), force: true },
        });
      } catch (error) {
        // A session that has expired took its tracks with it.
        if (error instanceof SfuError && (error.status === 404 || error.status === 410)) return;
        throw error;
      }
    },

    async setLayer(sessionId, mid, track) {
      const body = await call({
        op: "tracks/update",
        method: "PUT",
        path: `${session(sessionId)}/tracks/update`,
        session: sessionId,
        retry: true,
        body: {
          tracks: [
            {
              location: "remote",
              sessionId: track.sessionId,
              trackName: track.trackName,
              mid,
              simulcast: simulcastOptions(track.preferredRid),
            },
          ],
        },
      });
      const failed = itemsOf(body).find((item) => typeof item["errorCode"] === "string");
      if (failed !== undefined) throw new SfuError("tracks/update", 200, String(failed["errorCode"]));
    },
  };
}

function retryable(error: SfuError): boolean {
  if (error.code === "network" || error.code === "timeout") return true;
  if (error.status === 429 || error.status >= 500) return true;
  return TRANSIENT_CODES.has(error.code);
}

function itemsOf(body: Json): Json[] {
  const tracks = body["tracks"];
  if (!Array.isArray(tracks)) return [];
  return tracks.filter((item): item is Json => typeof item === "object" && item !== null && !Array.isArray(item));
}

function descriptionOf(body: Json): SessionDescription | null {
  const raw = body["sessionDescription"];
  if (typeof raw !== "object" || raw === null) return null;
  const { type, sdp } = raw as Json;
  if ((type !== "offer" && type !== "answer") || typeof sdp !== "string") return null;
  return { type, sdp };
}

function log(attempt: Attempt, status: number, outcome: string, started: number): void {
  logEvent("chat.call.sfu", {
    op: attempt.op,
    status,
    outcome,
    session: attempt.session === undefined ? undefined : hashId(attempt.session),
    ms: Date.now() - started,
  });
}
