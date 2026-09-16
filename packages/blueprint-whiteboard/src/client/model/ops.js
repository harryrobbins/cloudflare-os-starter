// @ts-check
// Pending local operations: their shape, how they apply optimistically to one object, which may
// be merged, which may share a request, and how they are written on the wire.
//
// Every object op names exactly one object, so the optimistic value of an object is its server
// value with the pending ops naming it applied in queue order (see view.js).

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/protocol.js").ObjectPatch} ObjectPatch */
/** @typedef {import("../../shared/protocol.js").ObjectOp} ObjectOp */
/** @typedef {import("../../shared/protocol.js").OperationRequest} OperationRequest */
/** @typedef {{title?: string, background?: "dots"|"grid"|"plain"}} StructurePatch */
/** @typedef {Omit<WhiteboardObject, "version"|"createdAt"|"updatedAt"|"createdBy">} NewObject */

/**
 * @typedef {(
 *   {kind: "create", id: string, object: NewObject, createdAt: number, createdBy: string}
 * | {kind: "update", id: string, patch: ObjectPatch}
 * | {kind: "delete", id: string}
 * | {kind: "structure", id?: undefined, structure: StructurePatch}
 * )} OpBody
 */

/**
 * @typedef {object} OpMeta
 * @property {number} seq        queue position key (a merged op keeps its target's seq)
 * @property {boolean} inflight  part of the request currently awaiting a result
 * @property {number} retries    automatic conflict retries so far
 * @property {boolean} replayed  sent before, outcome unknown (request failed or timed out)
 * @property {number} [sendFailures]  requests carrying this op that failed outright
 * @property {WhiteboardObject|null} [baseObject]  server object this update/delete was last sent against
 */

/** @typedef {OpBody & OpMeta} PendingOp */

/**
 * The object with a patch applied (style merges key by key). Never mutates `obj`.
 * @param {WhiteboardObject} obj
 * @param {ObjectPatch} patch
 * @returns {WhiteboardObject}
 */
export function patchObject(obj, patch) {
  const next = /** @type {WhiteboardObject} */ ({ ...obj, ...patch });
  next.style = patch.style ? { ...obj.style, ...patch.style } : obj.style;
  return next;
}

/**
 * One pending op applied to one object's value (null = absent).
 * @param {WhiteboardObject|null} obj
 * @param {OpBody} op
 * @returns {WhiteboardObject|null}
 */
export function applyOpToObject(obj, op) {
  switch (op.kind) {
    case "create":
      if (obj) return obj; // already on the server (its event overtook our result)
      return /** @type {WhiteboardObject} */ ({
        ...op.object, version: 0, createdAt: op.createdAt, updatedAt: op.createdAt, createdBy: op.createdBy,
      });
    case "update":
      return obj ? patchObject(obj, op.patch) : null;
    case "delete":
      return null;
    default:
      return obj;
  }
}

/**
 * Object ids an op refers to (other than the object it writes): frameId, connector endpoints.
 * @param {OpBody} op
 * @returns {string[]}
 */
export function refsOf(op) {
  /** @type {any} */
  const src = op.kind === "create" ? op.object : op.kind === "update" ? op.patch : null;
  if (!src) return [];
  /** @type {string[]} */
  const out = [];
  if (typeof src.frameId === "string") out.push(src.frameId);
  if (typeof src.from === "string" && src.from) out.push(src.from);
  if (typeof src.to === "string" && src.to) out.push(src.to);
  return out;
}

/**
 * Merges `next` into `target` (both naming the same object, `target` not yet sent) when the two
 * can travel as one op. Returns the merged body, "cancel" when both vanish (create then delete),
 * or null when they can't merge.
 * @param {OpBody} target
 * @param {OpBody} next
 * @returns {OpBody|"cancel"|null}
 */
export function mergeOps(target, next) {
  if (target.kind === "structure" || next.kind === "structure") {
    if (target.kind === "structure" && next.kind === "structure") {
      return { kind: "structure", structure: { ...target.structure, ...next.structure } };
    }
    return null;
  }
  if (target.id !== next.id) return null;
  if (target.kind === "create") {
    if (next.kind === "update") {
      return { ...target, object: /** @type {NewObject} */ (patchObject(/** @type {any} */ (target.object), next.patch)) };
    }
    if (next.kind === "delete") return "cancel";
    return null;
  }
  if (target.kind === "update") {
    if (next.kind === "update") return { kind: "update", id: target.id, patch: mergePatches(target.patch, next.patch) };
    if (next.kind === "delete") return next;
    return null;
  }
  return null;
}

/**
 * @param {ObjectPatch} a
 * @param {ObjectPatch} b
 * @returns {ObjectPatch}
 */
export function mergePatches(a, b) {
  const out = { ...a, ...b };
  if (a.style && b.style) out.style = { ...a.style, ...b.style };
  return out;
}

/**
 * The wire op for a pending op. `baseVersion` is supplied by the caller for updates and deletes.
 * @param {PendingOp} op
 * @param {number} baseVersion
 * @returns {ObjectOp|null}
 */
export function wireOp(op, baseVersion) {
  switch (op.kind) {
    case "create":
      return { op: "create", object: /** @type {any} */ (structuredCopy(op.object)) };
    case "update":
      return { op: "update", id: op.id, baseVersion, patch: structuredCopy(op.patch) };
    case "delete":
      return { op: "delete", id: op.id, baseVersion };
    default:
      return null;
  }
}

/**
 * A plain deep copy of JSON-like data (so later local edits can never alias what was sent).
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function structuredCopy(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return /** @type {any} */ (v.map(structuredCopy));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = structuredCopy(val);
  return /** @type {T} */ (out);
}
