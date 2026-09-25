// @ts-check
// Local-only URL cards. Stored as ordinary rectangles so older boards, backups and exports
// retain their content. No metadata requests, remote thumbnails, scripts or iframe embeds.
import { normalizeNewObject } from "./protocol.js";

export const LINK_LIMIT = 2048;
const HINT = "Select card → Open website…";

/** Parse a complete HTTP(S) URL without credentials or ambiguous whitespace/control characters.
 * @param {string} text
 */
export function describeLink(text) {
  if (typeof text !== "string" || text.length > LINK_LIMIT) return null;
  const source = text.trim();
  if (!/^https?:\/\//i.test(source) || /[\s\u0000-\u001f\u007f]/u.test(source)) return null;
  let url;
  try { url = new URL(source); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.href.length > LINK_LIMIT) return null;
  const host = url.hostname.toLowerCase();
  let videoId = null;
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else videoId = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } else if (host === "youtu.be") videoId = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) videoId = null;
  return { url: url.href, host, videoId, title: videoId ? `YouTube video · ${videoId}` : `Website · ${host}` };
}

/** @param {string} text @returns {import("./backup.js").Entry|null} */
export function linkToEntry(text) {
  const link = describeLink(text);
  if (!link) return null;
  const object = /** @type {Record<string, any>} */ (normalizeNewObject({
    id: "o_000000000000", type: "rect", w: 420, h: 200,
    text: `${link.title}\n${link.url}\n${HINT}`,
    style: { fill: "#eff6ff", stroke: "#93c5fd", textColor: "#172554", fontSize: 16, align: "left" },
  }));
  delete object.id; delete object.z; delete object.frameId;
  return { ref: "url0", index: 0, object, frameRef: null, fromRef: null, toRef: null };
}

/** Infer links only from an intact URL card or an object's entire URL text. Revalidate after edits.
 * @param {{text?: string, type?: string}} object
 */
export function objectLink(object) {
  if (!["rect", "sticky", "text"].includes(object.type ?? "")) return null;
  const text = object.text ?? "";
  const direct = describeLink(text);
  if (direct) return direct;
  const lines = text.split("\n");
  if (lines.length !== 3 || lines[2] !== HINT) return null;
  const link = describeLink(lines[1]);
  return link;
}
