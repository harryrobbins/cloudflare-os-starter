// @ts-check
// Links to a frame or an object: `#frame=<id>`, `#object=<id>`, and `#frame=<id>&present=1` to
// start presenting at a frame. A link carries only the id, never content.
//
// Where the hash comes from: the gadget runs in a sandboxed `srcdoc` iframe, whose own
// location is `about:srcdoc` (it has a hash only if something set one inside the frame), and it
// cannot read the host page's location. Its base URL, though, is the host page's URL, so
// `document.baseURI` carries the host page's `#...` when the page was opened with one. The link
// is read from the frame's own hash first, then from the base URL. Copied links are built on the
// host page's URL the same way. Whether the host keeps the fragment on its own URL (and passes it
// down) is the host's business; until it does, links work wherever the base URL keeps it.

import { isId } from "../../shared/protocol.js";

/** @typedef {{kind: "frame"|"object", id: string, present: boolean}} DeepLink */

/**
 * Parses `#frame=<id>` / `#object=<id>` (with optional `&present=1`). Null when absent or invalid.
 * @param {string|null|undefined} hash with or without the leading "#"
 * @returns {DeepLink|null}
 */
export function parseLink(hash) {
  if (typeof hash !== "string") return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || raw.length > 200) return null;
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const frame = params.get("frame");
  const object = params.get("object");
  const present = params.get("present") === "1";
  if (frame !== null) return isId(frame) ? { kind: "frame", id: frame, present } : null;
  if (object !== null) return isId(object) ? { kind: "object", id: object, present: false } : null;
  return null;
}

/** @param {string} url */
function hashOf(url) {
  const i = url.indexOf("#");
  return i < 0 ? "" : url.slice(i);
}

/**
 * The hash to read a link from: the frame's own, else the host page's (via the base URL).
 * @param {{hash?: string, baseURI?: string}} [where]
 */
export function currentHash(where = defaultWhere()) {
  if (where.hash && parseLink(where.hash)) return where.hash;
  const base = where.baseURI ?? "";
  return /^https?:/i.test(base) ? hashOf(base) : "";
}

function defaultWhere() {
  return {
    hash: typeof location !== "undefined" ? location.hash : "",
    baseURI: typeof document !== "undefined" ? document.baseURI : "",
  };
}

/**
 * A link to `id`: the host page's URL (from the base URL) with `#frame=` or `#object=`, or only
 * the fragment when no web URL is known.
 * @param {"frame"|"object"} kind @param {string} id
 * @param {{baseURI?: string, href?: string}} [where]
 */
export function linkFor(kind, id, where = {
  baseURI: typeof document !== "undefined" ? document.baseURI : "",
  href: typeof location !== "undefined" ? location.href : "",
}) {
  const fragment = `#${kind}=${encodeURIComponent(id)}`;
  const page = [where.baseURI, where.href].find((u) => typeof u === "string" && /^https?:/i.test(u));
  if (!page) return fragment;
  const i = page.indexOf("#");
  return (i < 0 ? page : page.slice(0, i)) + fragment;
}

/**
 * Follows a link on this viewer's view only: fits a frame, or selects and reveals an object.
 * Ids that are not on the board (deleted, or never there) are ignored with an announcement.
 * @param {import("./app.js").App} app
 * @param {DeepLink} link
 * @param {{present?: (frameId: string) => void}} [hooks]
 * @returns {boolean} whether the link was followed
 */
export function followLink(app, link, hooks = {}) {
  const o = app.store.getState().board.objects[link.id];
  if (!o || (link.kind === "frame" && o.type !== "frame")) {
    app.announce(`The linked ${link.kind} is not on this whiteboard.`);
    return false;
  }
  if (link.kind === "frame") {
    if (link.present && hooks.present) {
      hooks.present(link.id);
      return true;
    }
    app.canvas.fitObjects([link.id], { padding: 48 });
    app.announce(`Showing frame ${o.text || "without a name"}`);
  } else {
    app.canvas.setSelection([link.id]);
    app.canvas.focusObjects([link.id]);
  }
  return true;
}

/**
 * Follows the current link once the first snapshot has arrived (not before: the ids would not be
 * known yet), and again whenever the frame's own hash changes.
 * @param {import("./app.js").App} app
 * @param {{present?: (frameId: string) => void}} [hooks]
 * @returns {{onChange: (state: import("../store-contract.js").ClientState, change: import("../store-contract.js").Change) => void, destroy: () => void}}
 */
export function watchLinks(app, hooks = {}) {
  let done = false;
  const tryInitial = () => {
    if (done) return;
    done = true;
    const link = parseLink(currentHash());
    if (link) followLink(app, link, hooks);
  };
  const onHash = () => {
    const link = parseLink(typeof location !== "undefined" ? location.hash : "");
    if (link) followLink(app, link, hooks);
  };
  if (typeof window !== "undefined") window.addEventListener("hashchange", onHash);
  if (app.store.getState().connection === "live") queueMicrotask(tryInitial);
  return {
    onChange(state, change) {
      if (done) return;
      if (change.kind === "snapshot" || (change.kind === "connection" && state.connection === "live")) {
        // After the canvas has applied the snapshot (it subscribed first) and measured itself.
        setTimeout(tryInitial, 0);
      }
    },
    destroy() {
      if (typeof window !== "undefined") window.removeEventListener("hashchange", onHash);
    },
  };
}
