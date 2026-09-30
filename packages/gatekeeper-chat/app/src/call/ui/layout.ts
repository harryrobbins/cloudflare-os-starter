// The call UI's pure rules: grid shape, tile sizes, and the words on the history message and the
// error states. Kept out of the components so they are tested without a DOM.

import type { CallState, CallSummary, UserId } from "../../contract.js";
import type { TileSize } from "../engine/types.js";

/**
 * Tiles per row, top to bottom.
 *
 * Wide: 1 fills the pane, 2 sit side by side, 3 and 4 make a 2x2 (3 leaves the bottom row centred),
 * 5 is 3 over 2. Narrow (the dock, a phone): one column up to two people, then pairs.
 */
export function gridRows(count: number, narrow: boolean): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  if (narrow) {
    if (count === 2) return [1, 1];
    const rows: number[] = [];
    for (let left = count; left > 0; left -= 2) rows.push(Math.min(2, left));
    return rows;
  }
  if (count === 2) return [2];
  if (count <= 4) return count === 3 ? [2, 1] : [2, 2];
  const rows: number[] = [];
  for (let left = count; left > 0; left -= 3) rows.push(Math.min(3, left));
  // 5 -> [3, 2], 6 -> [3, 3]; never a lonely tile under three.
  return rows;
}

/** At or above this width a camera is worth the top simulcast layer. */
export const LARGE_TILE_PX = 640;
/** Below this it is a thumbnail. */
export const SMALL_TILE_PX = 240;

/** How big a tile is drawn, for the engine's layer choice. */
export function tileSizeFor(widthPx: number, options: { stage?: boolean; hidden?: boolean } = {}): TileSize {
  if (options.hidden === true || widthPx <= 0) return "hidden";
  if (options.stage === true || widthPx >= LARGE_TILE_PX) return "large";
  if (widthPx >= SMALL_TILE_PX) return "medium";
  return "small";
}

/** `under a minute`, `23 min`, `1 h`, `1 h 5 min`. */
export function formatCallDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The first word of a display name: "Harry" for "Harry Robbins". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Up to four first names, then "+N": the tail of "Call ended · 23 min · Harry, Alice, Bob". */
export function participantNames(ids: readonly UserId[], nameOf: (id: UserId) => string | undefined): string {
  const names = ids.map((id) => firstName(nameOf(id) ?? "Someone"));
  if (names.length <= 4) return names.join(", ");
  return `${names.slice(0, 4).join(", ")} +${names.length - 4}`;
}

/** The history line for a call, once it has ended. */
export function callEndedText(summary: CallSummary, nameOf: (id: UserId) => string | undefined): string {
  const parts = ["Call ended"];
  if (summary.endedAt !== null) parts.push(formatCallDuration(summary.endedAt - summary.startedAt));
  if (summary.participantIds.length > 0) parts.push(participantNames(summary.participantIds, nameOf));
  return parts.join(" · ");
}

/**
 * What to tell somebody whose camera or microphone was refused.
 *
 * Inside a frame the refusal is often the *frame's* permissions policy rather than the person's
 * choice -- the side panel needs `allow="camera; microphone"` -- and no browser setting fixes that,
 * so it says so.
 */
export function mediaHelp(options: { framed: boolean }): string {
  const allow =
    "Allow the camera and microphone for this site from the icon in the address bar, then try again.";
  return options.framed
    ? `${allow} If you are in the side panel, it may need an update before it can use them; opening chat in its own tab works meanwhile.`
    : allow;
}

/** True when this document is inside another one (the shell's dock or `/chat` page). */
export function isFramed(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access, which is itself an answer.
    return true;
  }
}

/** Screen share needs `getDisplayMedia`, which phones and tablets do not have. */
export function canShareScreen(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/** Raised hands in queue order (first raised first): participant id to its 1-based place. */
export function handQueue(room: CallState | undefined): ReadonlyMap<string, number> {
  const raised = (room?.participants ?? []).filter((participant) => participant.hand !== undefined);
  raised.sort((a, b) => a.hand! - b.hand!);
  return new Map(raised.map((participant, index) => [participant.id, index + 1]));
}
