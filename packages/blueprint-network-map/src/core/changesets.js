// @ts-check
// Changesets: reviewed imports (Phase 1) and, later, agent proposals (Phase 3). Nothing in a
// changeset touches the map until a reviewer accepts it.
//
//   createChangeset({name, source, format, by})          -> manifest (status "staging")
//   addChangesetItems({changesetId, items})               items in pages of LIMITS.opsPerRequest
//   finalizeChangeset({changesetId})                      server-side resolution -> status "review"
//   getChangeset({changesetId, cursor, limit})            manifest + a page of resolved items
//   setDecisions({changesetId, decisions})                per-item action changes; new digest
//   acceptChangeset({changesetId, digest, by, senderId})  applies in chunks -> "applied"|"partial"
//   resumeChangeset(...)                                  continues an interrupted "applying" job
//   rejectChangeset({changesetId})                        discards it
//
// Items (caller input, validated here):
//   {kind: "type", name, appliesTo, color?}
//   {kind: "field", name, fieldKind, appliesTo?, choices?}
//   {kind: "element", key, label, type?, description?, tags?, aliases?, fields?: {name: value}}
//   {kind: "connection", key?, from, to, type?, direction?, label?, polarity?, strength?,
//    description?, tags?, fields?}   from/to are element keys of this changeset, or element ids
//
// Resolution: types and fields match existing ones by name. An element whose (source, key) matches
// an existing element's external reference is an "update"; one whose label matches exactly one
// existing element is suggested as "use-existing" (a label never proves identity: the reviewer
// can switch it to "create"); otherwise "create" with an id assigned now, so a retried or resumed
// apply can never create it twice. A connection's endpoints resolve through the element items; a
// skipped endpoint blocks it; an unresolved one makes it invalid.
//
// Acceptance binds the digest the reviewer saw: any change to items or decisions changes it, and
// accepting with an old digest is refused. The digest proves the changeset is unchanged, not that
// a person pressed the button: any caller holding the gadget stub (including the Workshop agent)
// can call acceptChangeset. Review is a cooperative workflow until S10 establishes a server-
// verifiable acceptance path (docs/plans/network-map-blueprint.md §7.1).
//
// Apply: schema items, then elements, then connections, in batches of at most LIMITS.commitObjects
// ops. Each batch is one map commit (one history entry, all sharing groupId = changeset id) that
// also writes the items' new states, so a crash leaves every item either applied with its object
// or pending without it. The whole job is not atomic: a failure reports partial application.

import {
  LIMITS as DEFAULT_LIMITS, cleanFieldValue, cleanLine, cleanName, cleanStringList, cleanText, digestOf,
  isId, isObject, normalizeLabel, storedBytes, FIELD_KINDS, DIRECTIONS,
} from "../shared/protocol.js";
import { chunkByBytes } from "./network-map.js";

const ITEMS_PER_CHUNK = 500;
const MANIFESTS_KEPT = 30;
const ITEMS_KEPT = 5;
const WARNINGS = 50;
const STATUS = /** @type {const} */ (["staging", "review", "applying", "applied", "partial", "failed", "rejected"]);

/** @param {string} message */
const refuse = (message) => { throw new Error(message); };

/**
 * @param {ReturnType<typeof import("./network-map.js").createNetworkMap>} map
 */
export function createChangesets(map) {
  const { enqueue, load, applyLocked, emit, repo, now, newId } = map._internal;
  const L = map.LIMITS;

  /** @param {any} s */
  const stagingBytes = (s) => [...s.changesets.values()].reduce((n, m) => n + (m.bytes ?? 0), 0);

  /** @param {any} s @param {string} id */
  function manifestOf(s, id) {
    const m = typeof id === "string" ? s.changesets.get(id) : null;
    if (!m) refuse(`No changeset ${cleanLine(id, 40)}`);
    return m;
  }

  /** @param {any} s @param {any} m */
  async function readItems(s, m) {
    const items = [];
    for (let n = 0; n < m.chunks; n++) items.push(...((await repo.getChangesetChunk(m.id, n)) ?? []));
    return items;
  }

  /** Writes manifest (and optionally chunks) and emits. @param {any} s @param {any} m @param {Record<string, any>} [chunks] */
  async function saveManifest(s, m, chunks) {
    await repo.commit({ changesets: { [m.id]: m }, changesetChunks: chunks });
    s.changesets.set(m.id, m);
    emit({ type: "changeset", changeset: structuredClone(m) });
  }

  /** @param {any[]} items */
  function toChunks(items) {
    /** @type {Record<string, any[]>} */
    const chunks = {};
    const list = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) {
      for (const part of chunkByBytes(items.slice(i, i + ITEMS_PER_CHUNK), L.valueBytes)) list.push(part);
    }
    list.forEach((c, n) => { chunks[n] = c; });
    return { list, bytes: list.reduce((n, c) => n + storedBytes(c), 0) };
  }

  /** @param {any} m @param {any[]} items */
  function countsOf(m, items) {
    /** @type {Record<string, number>} */
    const counts = { create: 0, update: 0, "use-existing": 0, skip: 0, invalid: 0, blocked: 0, applied: 0, failed: 0 };
    for (const it of items) {
      if (it.state === "applied") counts.applied++;
      else if (it.state === "failed") counts.failed++;
      if (it.decided === "skip" || it.action === "skip") counts.skip++;
      else if (it.problems?.length && it.invalid) counts.invalid++;
      else if (it.blocked) counts.blocked++;
      else counts[it.action] = (counts[it.action] ?? 0) + 1;
    }
    return counts;
  }

  /** @param {any[]} items */
  const itemsDigest = (items) => digestOf(items.map((it) => [it.iid, it.action, it.targetId ?? null, it.invalid ? 1 : 0, it.blocked ? 1 : 0, it.data]));

  // --- Validation of caller items ------------------------------------------------------------

  /**
   * @param {unknown} raw
   * @returns {{value: any}|{error: string}}
   */
  function cleanItem(raw) {
    if (!isObject(raw)) return { error: "Each item must be an object" };
    const fields = (/** @type {unknown} */ f) => {
      if (!isObject(f)) return {};
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, v] of Object.entries(f).slice(0, L.fields)) {
        const name = cleanLine(k, L.fieldName);
        if (!name || v === null || v === undefined || v === "") continue;
        out[name] = typeof v === "string" ? cleanText(v, L.fieldLongText) : Array.isArray(v) ? cleanStringList(v, L.choices, L.choice) : isObject(v) ? { from: v.from ?? null, to: v.to ?? null } : v;
      }
      return out;
    };
    switch (raw.kind) {
      case "type": {
        const name = cleanLine(raw.name, L.typeName);
        if (!name || (raw.appliesTo !== "element" && raw.appliesTo !== "connection")) return { error: "A type item needs name and appliesTo" };
        return { value: { kind: "type", name, appliesTo: raw.appliesTo, ...(typeof raw.color === "string" ? { color: raw.color } : {}) } };
      }
      case "field": {
        const name = cleanLine(raw.name, L.fieldName);
        if (!name || !FIELD_KINDS.includes(raw.fieldKind)) return { error: "A field item needs name and fieldKind" };
        return {
          value: {
            kind: "field", name, fieldKind: raw.fieldKind, appliesTo: ["element", "connection", "both"].includes(raw.appliesTo) ? raw.appliesTo : "element",
            choices: cleanStringList(raw.choices, L.choices, L.choice),
          },
        };
      }
      case "element": {
        const label = cleanLine(raw.label, L.label);
        const key = cleanLine(raw.key ?? label, L.externalKey);
        if (!label || !key) return { error: "An element item needs a label" };
        return {
          value: {
            kind: "element", key, label, type: cleanLine(raw.type, L.typeName) || undefined,
            description: cleanText(raw.description, L.description) || undefined,
            tags: cleanStringList(raw.tags, L.tags, L.tag), aliases: cleanStringList(raw.aliases, L.aliases, L.label),
            fields: fields(raw.fields),
          },
        };
      }
      case "connection": {
        const from = cleanLine(raw.from, L.externalKey), to = cleanLine(raw.to, L.externalKey);
        if (!from || !to) return { error: "A connection item needs from and to" };
        const direction = DIRECTIONS.includes(raw.direction) ? raw.direction : "directed";
        const polarity = raw.polarity === "+" || raw.polarity === "-" ? raw.polarity : undefined;
        const strength = typeof raw.strength === "number" && Number.isFinite(raw.strength) ? raw.strength : typeof raw.strength === "string" && raw.strength.trim() !== "" && Number.isFinite(Number(raw.strength)) ? Number(raw.strength) : undefined;
        const type = cleanLine(raw.type, L.typeName) || undefined;
        const label = cleanLine(raw.label, L.label) || undefined;
        const key = cleanLine(raw.key, L.externalKey) || `${from} -> ${to}${type ? " : " + type : ""}${label ? " : " + label : ""}`.slice(0, L.externalKey);
        return {
          value: {
            kind: "connection", key, from, to, direction, polarity, strength, type, label,
            description: cleanText(raw.description, L.description) || undefined,
            tags: cleanStringList(raw.tags, L.tags, L.tag), fields: fields(raw.fields),
          },
        };
      }
      default:
        return { error: 'kind must be "type", "field", "element" or "connection"' };
    }
  }

  // --- Resolution -----------------------------------------------------------------------------

  /**
   * Resolves every item against the map (see the header). Mutates items.
   * @param {any} s @param {any} m @param {any[]} items
   */
  function resolve(s, m, items) {
    const objects = [...s.objects.values()];
    /** @type {Map<string, string>} "appliesTo\0name" -> type id */
    const types = new Map();
    for (const o of objects) if (o.id[0] === "t") types.set(o.appliesTo + "\0" + normalizeLabel(o.name), o.id);
    /** @type {Map<string, any>} name -> field def (existing or staged) */
    const fields = new Map();
    for (const o of objects) if (o.id[0] === "f") fields.set(normalizeLabel(o.name), o);
    /** @type {Map<string, any>} element key -> item */
    const elementItems = new Map();
    const warnings = new Set();
    /** @type {Map<string, string>} "sourceId\0key" -> connection id */
    const connectionRefs = new Map();
    for (const o of objects) if (o.id[0] === "c") for (const r of o.externalRefs ?? []) connectionRefs.set(r.sourceId + "\0" + r.key, o.id);

    for (const it of items) {
      it.problems = [];
      delete it.invalid;
      delete it.blocked;
      const d = it.data;
      if (d.kind === "type") {
        const existing = types.get(d.appliesTo + "\0" + normalizeLabel(d.name));
        if (existing) { it.action = "use-existing"; it.targetId = existing; }
        else {
          it.action = it.decided === "skip" ? "skip" : "create";
          it.targetId = it.newId ??= newId("type");
          if (it.action === "create") types.set(d.appliesTo + "\0" + normalizeLabel(d.name), it.targetId);
        }
      } else if (d.kind === "field") {
        const existing = fields.get(normalizeLabel(d.name));
        if (existing && existing.id && s.objects.has(existing.id)) {
          it.action = "use-existing"; it.targetId = existing.id;
          if (existing.kind !== d.fieldKind) it.problems.push(`A field "${existing.name}" already exists as ${existing.kind}; values are checked against it`);
          if (existing.appliesTo !== "both" && d.appliesTo !== existing.appliesTo) {
            it.problems.push(`The existing field "${existing.name}" applies to ${existing.appliesTo}s only; ${d.appliesTo === "both" ? "other" : d.appliesTo} values will be skipped`);
          }
        } else {
          it.action = it.decided === "skip" ? "skip" : "create";
          it.targetId = it.newId ??= newId("field");
          if ((d.fieldKind === "choice" || d.fieldKind === "multichoice") && !d.choices.length) { it.invalid = true; it.problems.push("A choice field needs choices"); }
          if (it.action === "create") fields.set(normalizeLabel(d.name), { id: it.targetId, name: d.name, kind: d.fieldKind, appliesTo: d.appliesTo, choices: d.choices, staged: true });
        }
      }
    }
    for (const it of items) {
      const d = it.data;
      if (d.kind !== "element") continue;
      if (elementItems.has(d.key)) { it.invalid = true; it.problems.push(`Duplicate key "${d.key}" in this import`); continue; }
      elementItems.set(d.key, it);
      if (d.type && !types.has("element\0" + normalizeLabel(d.type))) { it.problems.push(`Unknown element type "${d.type}"; it will be untyped`); warnings.add(`Unknown element type "${d.type}"`); }
      const byRef = s.byRef.get(m.source + "\0" + d.key);
      const candidates = [...(s.byLabel.get(normalizeLabel(d.label)) ?? [])];
      it.candidates = candidates.slice(0, 5);
      if (it.decided) {
        it.action = it.decided;
        if (it.decided === "use-existing" || it.decided === "update") {
          if (!isId(it.decidedTarget, "element") || !s.objects.has(it.decidedTarget)) { it.invalid = true; it.problems.push("The chosen existing element no longer exists"); }
          else it.targetId = it.decidedTarget;
        } else if (it.decided === "create") it.targetId = it.newId ??= newId("element");
      } else if (byRef) { it.action = "update"; it.targetId = byRef; }
      else if (candidates.length === 1) { it.action = "use-existing"; it.targetId = candidates[0]; it.problems.push("Matches an existing element by label: check it is the same thing"); }
      else {
        it.action = "create";
        it.targetId = it.newId ??= newId("element");
        if (candidates.length > 1) it.problems.push(`${candidates.length} existing elements have this label; a new one will be created unless you pick one`);
      }
    }
    /** @type {Set<string>} */
    const connectionKeys = new Set();
    for (const it of items) {
      const d = it.data;
      if (d.kind !== "connection") continue;
      if (connectionKeys.has(d.key)) { it.invalid = true; it.problems.push(`Duplicate connection "${d.key}" in this import`); continue; }
      connectionKeys.add(d.key);
      if (d.type && !types.has("connection\0" + normalizeLabel(d.type))) { it.problems.push(`Unknown connection type "${d.type}"; it will be untyped`); warnings.add(`Unknown connection type "${d.type}"`); }
      /** @type {(string|null)[]} */
      const ends = [];
      for (const end of [d.from, d.to]) {
        const item = elementItems.get(end);
        if (item) {
          if (item.invalid) { it.invalid = true; it.problems.push(`Endpoint "${end}" is invalid`); ends.push(null); }
          else if (item.action === "skip") { it.blocked = true; it.problems.push(`Endpoint "${end}" is skipped`); ends.push(null); }
          else ends.push(item.targetId);
        } else if (isId(end, "element") && s.objects.has(end)) ends.push(end);
        else { it.invalid = true; it.problems.push(`No element "${end}" in this import or the map`); ends.push(null); }
      }
      it.ends = ends;
      if (it.decided === "skip") it.action = "skip";
      else {
        const existing = connectionRefs.get(m.source + "\0" + d.key);
        if (existing) { it.action = "update"; it.targetId = existing; }
        else { it.action = "create"; it.targetId = it.newId ??= newId("connection"); }
      }
    }
    // What the reviewer saw: an existing target changed after review makes its item fail as stale
    // instead of overwriting the newer edit.
    for (const it of items) {
      const target = (it.action === "update" || it.action === "use-existing") && (it.data.kind === "element" || it.data.kind === "connection") ? s.objects.get(it.targetId) : null;
      if (target) it.expectVersion = target.version;
      else delete it.expectVersion;
    }
    m.warnings = [...warnings].slice(0, WARNINGS);
  }

  // --- Building ops ---------------------------------------------------------------------------

  /**
   * The op that applies one item, or null when it has nothing to do.
   * @param {any} s @param {any} m @param {any} it @param {Map<string, any>} fieldDefs name -> def
   * @param {Map<string, string>} typeIds "appliesTo\0name" -> id
   * @param {string} by
   * @param {Map<string, any>} working  targets as earlier ops of this batch left them, so two rows
   *   matched to one element merge instead of the later one overwriting the earlier
   * @returns {any} an op, null for nothing to do, or {missing: true} when the target is gone
   */
  function opFor(s, m, it, fieldDefs, typeIds, by, working) {
    const d = it.data;
    const provenance = { origin: "import", changesetId: m.id, sourceName: m.name, at: now(), acceptedBy: by };
    const values = (/** @type {Record<string, unknown>} */ raw, /** @type {"element"|"connection"} */ kind) => {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [name, v] of Object.entries(raw ?? {})) {
        const def = fieldDefs.get(normalizeLabel(name));
        if (!def || !(def.appliesTo === "both" || def.appliesTo === kind)) { it.warnings = [...(it.warnings ?? []), `Field "${name}" skipped: not a ${kind} field`].slice(0, 5); continue; }
        const value = cleanFieldValue(def, v);
        if (value === undefined || value === null) { it.warnings = [...(it.warnings ?? []), `Field "${name}": value "${cleanLine(v, 40)}" is not a valid ${def.kind}`].slice(0, 5); continue; }
        out[def.id] = value;
      }
      return out;
    };
    if (it.action === "skip" || it.invalid || it.blocked) return null;
    if (d.kind === "type") {
      if (it.action !== "create") return null;
      return { op: "create", object: { id: it.targetId, name: d.name, appliesTo: d.appliesTo, ...(d.color ? { color: d.color } : {}) } };
    }
    if (d.kind === "field") {
      if (it.action !== "create") return null;
      return { op: "create", object: { id: it.targetId, name: d.name, kind: d.fieldKind, appliesTo: d.appliesTo, choices: d.choices } };
    }
    const kind = d.kind;
    const typeId = d.type ? typeIds.get(kind + "\0" + normalizeLabel(d.type)) ?? null : undefined;
    const ref = { sourceId: m.source, key: d.key };
    if (kind === "element") {
      const fields = values(d.fields, "element");
      if (it.action === "create") {
        return { op: "create", object: { id: it.targetId, label: d.label, typeId: typeId ?? null, description: d.description, tags: d.tags, aliases: d.aliases, fields, externalRefs: [ref], provenance } };
      }
      const cur = working.get(it.targetId) ?? s.objects.get(it.targetId);
      if (!cur) return { missing: true };
      const base = it.expectVersion ?? cur.version;
      const refs = [...(cur.externalRefs ?? []).filter((/** @type {any} */ r) => !(r.sourceId === ref.sourceId && r.key === ref.key)), ref].slice(-L.externalRefs);
      if (it.action === "update") {
        // The import owns what it provides; what it leaves out stays.
        /** @type {Record<string, any>} */
        const patch = { label: d.label, fields, externalRefs: refs };
        if (typeId !== undefined) patch.typeId = typeId;
        if (d.description) patch.description = d.description;
        if (d.tags.length) patch.tags = [...new Set([...(cur.tags ?? []), ...d.tags])];
        return track(working, cur, { op: "update", id: cur.id, baseVersion: base, patch });
      }
      // use-existing: link, and only fill what is empty.
      /** @type {Record<string, any>} */
      const patch = { externalRefs: refs };
      /** @type {Record<string, unknown>} */
      const fill = {};
      for (const [fid, v] of Object.entries(fields)) if (cur.fields?.[fid] === undefined) fill[fid] = v;
      if (Object.keys(fill).length) patch.fields = fill;
      if (!cur.description && d.description) patch.description = d.description;
      if (!cur.typeId && typeId) patch.typeId = typeId;
      if (normalizeLabel(d.label) !== normalizeLabel(cur.label) && !(cur.aliases ?? []).some((/** @type {string} */ a) => normalizeLabel(a) === normalizeLabel(d.label))) {
        patch.aliases = [...(cur.aliases ?? []), d.label];
      }
      return track(working, cur, { op: "update", id: cur.id, baseVersion: base, patch });
    }
    // connection
    const [from, to] = it.ends ?? [];
    if (!from || !to) return null;
    const fields = values(d.fields, "connection");
    const content = {
      from, to, direction: d.direction, typeId: typeId ?? null, label: d.label, polarity: d.polarity, strength: d.strength,
      description: d.description, tags: d.tags, fields,
    };
    if (it.action === "create") return { op: "create", object: { id: it.targetId, ...content, externalRefs: [ref], provenance } };
    const cur = working.get(it.targetId) ?? s.objects.get(it.targetId);
    if (!cur) return { missing: true };
    /** @type {Record<string, any>} */
    const patch = { from, to, direction: d.direction, fields };
    if (typeId !== undefined) patch.typeId = typeId;
    for (const k of /** @type {const} */ (["label", "polarity", "strength", "description"])) if (d[k] !== undefined) patch[k] = d[k];
    return track(working, cur, { op: "update", id: cur.id, baseVersion: it.expectVersion ?? cur.version, patch });
  }

  /**
   * Records what an update op leaves its target as, for later ops of the same batch.
   * @param {Map<string, any>} working @param {any} cur @param {any} op
   */
  function track(working, cur, op) {
    const next = { ...cur, ...op.patch };
    if (op.patch.fields) next.fields = { ...(cur.fields ?? {}), ...op.patch.fields };
    working.set(cur.id, next);
    return op;
  }

  /**
   * Applies every pending item, batch by batch.
   * @param {any} m @param {string} by @param {string} senderId
   */
  async function runJob(m, by, senderId) {
    const phases = ["type", "field", "element", "connection"];
    let part = 0;
    for (const phase of phases) {
      for (;;) {
        const done = await enqueue(async () => {
          const s = await load();
          const man = s.changesets.get(m.id);
          if (!man || man.status !== "applying") return true;
          const items = await readItems(s, man);
          resolveEndsForApply(s, items);
          const fieldDefs = new Map();
          for (const o of s.objects.values()) if (o.id[0] === "f") fieldDefs.set(normalizeLabel(o.name), o);
          const typeIds = new Map();
          for (const o of s.objects.values()) if (o.id[0] === "t") typeIds.set(o.appliesTo + "\0" + normalizeLabel(o.name), o.id);
          const pending = items.filter((it) => it.data.kind === phase && it.state === "pending");
          if (!pending.length) return true;
          const batch = [];
          const ops = [];
          const working = new Map();
          for (const it of pending) {
            if (ops.length >= L.commitObjects) break;
            let op = opFor(s, man, it, fieldDefs, typeIds, by, working);
            if (op?.missing) { it.state = "failed"; it.error = "Its target no longer exists; import again to review it"; op = null; }
            batch.push(it);
            ops.push(op);
          }
          const real = ops.map((op, i) => ({ op, it: batch[i] })).filter((x) => x.op);
          part++;
          const noun = phase === "element" ? "elements" : phase === "connection" ? "connections" : phase + "s";
          const summary = `Imported ${real.length} ${noun} from “${cleanLine(man.name, 60)}”${part > 1 ? ` (part ${part})` : ""}`;
          /**
           * @param {any} result
           * @param {boolean} committed false when the map refused the whole request (a loop would
           *   break): then only the ops it names fail, and the rest stay pending for the next pass
           */
          const settle = (result, committed) => {
            const failed = new Map(result ? result.errors.filter((/** @type {any} */ e) => e.index >= 0).map((/** @type {any} */ e) => [e.index, e.message]) : []);
            const conflicted = new Set(result ? result.conflicts.map((/** @type {any} */ c) => c.id) : []);
            const refusedWhole = !committed && failed.size > 0;
            real.forEach((x, i) => {
              if (failed.has(i)) { x.it.state = "failed"; x.it.error = failed.get(i); }
              else if (conflicted.has(x.op.id)) { x.it.state = "failed"; x.it.error = "Changed after it was reviewed; import again to review it"; }
              else if (!refusedWhole) x.it.state = "applied";
            });
            for (const it of batch) if (it.state === "pending" && !real.some((x) => x.it === it)) it.state = it.action === "skip" || it.invalid || it.blocked ? "skipped" : "applied";
            // A later row matched to a target this batch changed expects the new version.
            if (committed) {
              for (const x of real) {
                if (x.op.op !== "update" || x.it.state !== "applied") continue;
                const v = s.objects.get(x.op.id)?.version;
                for (const other of items) if (other.state === "pending" && other.targetId === x.op.id && other.expectVersion !== undefined) other.expectVersion = v;
              }
            }
            const next = { ...man, updatedAt: now(), counts: countsOf(man, items), applied: items.filter((it) => it.state === "applied").length };
            const { list } = toChunks(items);
            /** @type {Record<string, any[]|null>} */
            const chunks = {};
            list.forEach((c, n) => { chunks[`${man.id}:${n}`] = c; });
            for (let n = list.length; n < man.chunks; n++) chunks[`${man.id}:${n}`] = null;
            next.chunks = list.length;
            return { next, commit: { changesets: { [man.id]: next }, changesetChunks: chunks } };
          };
          let settled = /** @type {any} */ (null);
          if (real.length) {
            const { result } = await applyLocked(
              { senderId, by, ops: real.map((x) => x.op) },
              { summary, groupId: man.id, extraCommit: (/** @type {any} */ r) => (settled = settle(r, true)).commit },
            );
            if (!settled) {
              // Nothing was committed (every op failed, or the request was refused as a whole):
              // record the item states alone.
              settled = settle(result, false);
              await repo.commit(settled.commit);
            }
          } else {
            settled = settle(null, true);
            await repo.commit(settled.commit);
          }
          s.changesets.set(man.id, settled.next);
          emit({ type: "changeset", changeset: structuredClone(settled.next) });
          return false;
        });
        if (done) break;
      }
    }
    return enqueue(async () => {
      const s = await load();
      const man = s.changesets.get(m.id);
      if (!man || man.status !== "applying") return man ? structuredClone(man) : null;
      const items = await readItems(s, man);
      const failed = items.filter((it) => it.state === "failed").length;
      const next = { ...man, status: failed ? "partial" : "applied", updatedAt: now(), counts: countsOf(man, items), applied: items.filter((it) => it.state === "applied").length };
      await saveManifest(s, next);
      await pruneManifests(s);
      return structuredClone(next);
    });
  }

  /**
   * Connection endpoints are element item targets; re-derive them for apply (items read back
   * from storage keep `ends`, but an element item that failed to apply must block its edges).
   * @param {any} s @param {any[]} items
   */
  function resolveEndsForApply(s, items) {
    const byKey = new Map(items.filter((it) => it.data.kind === "element").map((it) => [it.data.key, it]));
    const pendingTargets = new Set(items.filter((x) => x.state === "pending").map((x) => x.targetId));
    for (const it of items) {
      if (it.data.kind !== "connection" || it.state !== "pending") continue;
      for (const end of [it.data.from, it.data.to]) {
        const e = byKey.get(end);
        if (e && (e.state === "failed" || e.state === "skipped")) { it.state = "failed"; it.error = `Endpoint "${end}" was not imported`; }
      }
      if (it.state === "pending" && it.ends?.some((/** @type {string|null} */ id) => id && !s.objects.has(id) && !pendingTargets.has(id))) {
        it.state = "failed";
        it.error = "An endpoint no longer exists";
      }
    }
  }

  /**
   * Keeps the newest MANIFESTS_KEPT finished manifests. Items stay for the newest ITEMS_KEPT
   * finished ones (so their outcome can be reviewed), while staging stays under half its quota;
   * older finished changesets keep only their manifest.
   * @param {any} s
   */
  async function pruneManifests(s) {
    const finished = [...s.changesets.values()].filter((m) => ["applied", "partial", "rejected", "failed"].includes(m.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    /** @type {Record<string, any>} */
    const changesets = {};
    /** @type {Record<string, any>} */
    const chunks = {};
    for (const [i, m] of finished.entries()) {
      if (i >= MANIFESTS_KEPT) { changesets[m.id] = null; s.changesets.delete(m.id); continue; }
      const keepItems = m.status !== "rejected" && i < ITEMS_KEPT && stagingBytes(s) <= L.stagingBytes / 2;
      if (keepItems) continue;
      if (m.chunks) {
        for (let n = 0; n < m.chunks; n++) chunks[`${m.id}:${n}`] = null;
        const next = { ...m, chunks: 0, bytes: 0 };
        changesets[m.id] = next;
        s.changesets.set(m.id, next);
      }
    }
    if (Object.keys(changesets).length || Object.keys(chunks).length) await repo.commit({ changesets, changesetChunks: chunks });
  }

  // --- Public ---------------------------------------------------------------------------------

  return {
    /** @param {any} args {name, source?, format?, by} */
    createChangeset: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const name = cleanLine(a.name, 120) || "Import";
      const id = newId("changeset");
      const m = {
        id, name, source: cleanLine(a.source, 80) || `import:${normalizeLabel(name).slice(0, 60)}`, format: cleanLine(a.format, 40) || "items",
        origin: "import", status: "staging", createdBy: cleanName(a.by, "Anonymous"), createdAt: now(), updatedAt: now(),
        chunks: 0, items: 0, bytes: 0, digest: "", counts: {}, applied: 0, warnings: [],
      };
      await saveManifest(s, m);
      return structuredClone(m);
    }),

    /** @param {any} args {changesetId, items} */
    addChangesetItems: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const m = manifestOf(s, a.changesetId);
      if (m.status !== "staging") refuse("Items can only be added while the changeset is staging");
      if (!Array.isArray(a.items)) refuse("items must be an array");
      if (a.items.length > L.opsPerRequest) refuse(`At most ${L.opsPerRequest} items per call`);
      const cleaned = [];
      const errors = [];
      for (const [i, raw] of a.items.entries()) {
        const c = cleanItem(raw);
        if ("error" in c) errors.push({ index: i, message: c.error });
        else cleaned.push(c.value);
      }
      const limit = L.elements + L.connections + L.types + L.fields;
      if (m.items + cleaned.length > limit) refuse(`A changeset may hold at most ${limit} items`);
      const start = m.items;
      const items = cleaned.map((data, i) => ({ iid: `i${start + i}`, data, action: "create", state: "pending" }));
      // Append as new chunks after the existing ones.
      const { list, bytes } = toChunks(items);
      if (stagingBytes(s) + bytes > L.stagingBytes) refuse(`Staged imports may take at most ${L.stagingBytes / 1024 / 1024} MiB; accept or discard one first`);
      /** @type {Record<string, any[]>} */
      const chunks = {};
      list.forEach((c, n) => { chunks[`${m.id}:${m.chunks + n}`] = c; });
      const next = { ...m, chunks: m.chunks + list.length, items: m.items + items.length, bytes: m.bytes + bytes, updatedAt: now() };
      await saveManifest(s, next, chunks);
      return { added: items.length, errors: errors.slice(0, 50), items: next.items };
    }),

    /** @param {any} args {changesetId} */
    finalizeChangeset: (args) => enqueue(async () => {
      const s = await load();
      const m = manifestOf(s, args?.changesetId);
      if (m.status !== "staging" && m.status !== "review") refuse("Only a staging changeset can be finalised");
      const items = await readItems(s, m);
      resolve(s, m, items);
      const { list, bytes } = toChunks(items);
      /** @type {Record<string, any[]|null>} */
      const chunks = {};
      list.forEach((c, n) => { chunks[`${m.id}:${n}`] = c; });
      for (let n = list.length; n < m.chunks; n++) chunks[`${m.id}:${n}`] = null;
      const next = { ...m, status: "review", chunks: list.length, bytes, digest: itemsDigest(items), counts: countsOf(m, items), updatedAt: now() };
      await saveManifest(s, next, chunks);
      return structuredClone(next);
    }),

    /** @param {any} args {changesetId, cursor?, limit?, filter?: "problems"|"all"} */
    getChangeset: (args) => enqueue(async () => {
      const s = await load();
      const m = manifestOf(s, args?.changesetId);
      const items = await readItems(s, m);
      const filtered = args?.filter === "problems" ? items.filter((it) => it.problems?.length || it.invalid || it.blocked || it.state === "failed") : items;
      const cursor = Number.isSafeInteger(args?.cursor) && args.cursor >= 0 ? args.cursor : 0;
      const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 200;
      const page = filtered.slice(cursor, cursor + limit).map((it) => ({
        ...it, candidates: (it.candidates ?? []).map((/** @type {string} */ id) => ({ id, label: s.objects.get(id)?.label ?? id })),
        target: it.targetId && s.objects.has(it.targetId) ? { id: it.targetId, label: s.objects.get(it.targetId).label ?? s.objects.get(it.targetId).name } : null,
      }));
      return structuredClone({ changeset: m, items: page, next: cursor + limit < filtered.length ? cursor + limit : null, total: filtered.length });
    }),

    /** @param {any} args {changesetId, decisions: [{iid, action, targetId?}]} */
    setDecisions: (args) => enqueue(async () => {
      const s = await load();
      const m = manifestOf(s, args?.changesetId);
      if (m.status !== "review") refuse("Decisions can only change while the changeset is in review");
      if (!Array.isArray(args.decisions)) refuse("decisions must be an array");
      const items = await readItems(s, m);
      const byIid = new Map(items.map((it) => [it.iid, it]));
      let changed = 0;
      for (const d of args.decisions.slice(0, 5000)) {
        const it = isObject(d) ? byIid.get(d.iid) : null;
        if (!it || !["create", "use-existing", "update", "skip"].includes(d.action)) continue;
        if ((d.action === "use-existing" || d.action === "update") && it.data.kind !== "element") continue;
        it.decided = d.action;
        it.decidedTarget = isId(d.targetId, "element") ? d.targetId : it.targetId;
        changed++;
      }
      resolve(s, m, items);
      const { list, bytes } = toChunks(items);
      /** @type {Record<string, any[]|null>} */
      const chunks = {};
      list.forEach((c, n) => { chunks[`${m.id}:${n}`] = c; });
      for (let n = list.length; n < m.chunks; n++) chunks[`${m.id}:${n}`] = null;
      const next = { ...m, chunks: list.length, bytes, digest: itemsDigest(items), counts: countsOf(m, items), updatedAt: now() };
      await saveManifest(s, next, chunks);
      return { changed, changeset: structuredClone(next) };
    }),

    /** @param {any} args {changesetId, digest, by, senderId} */
    acceptChangeset: async (args) => {
      const a = isObject(args) ? args : {};
      const by = cleanName(a.by, "Anonymous");
      const m = await enqueue(async () => {
        const s = await load();
        const man = manifestOf(s, a.changesetId);
        if (man.status !== "review") refuse(`This changeset is ${man.status}, not in review`);
        if (a.digest !== man.digest) refuse("The changeset changed since you reviewed it; review it again");
        const next = { ...man, status: "applying", acceptedBy: by, acceptedAt: now(), updatedAt: now() };
        await saveManifest(s, next);
        return next;
      });
      return runJob(m, by, typeof a.senderId === "string" ? cleanLine(a.senderId, 64) : "");
    },

    /** @param {any} args {changesetId, by, senderId} */
    resumeChangeset: async (args) => {
      const a = isObject(args) ? args : {};
      const m = await enqueue(async () => {
        const s = await load();
        const man = manifestOf(s, a.changesetId);
        if (man.status !== "applying") refuse(`This changeset is ${man.status}, not applying`);
        return man;
      });
      return runJob(m, cleanName(a.by ?? m.acceptedBy, "Anonymous"), typeof a.senderId === "string" ? cleanLine(a.senderId, 64) : "");
    },

    /** @param {any} args {changesetId} */
    rejectChangeset: (args) => enqueue(async () => {
      const s = await load();
      const m = manifestOf(s, args?.changesetId);
      if (m.status === "applying") refuse("An import that is being applied cannot be discarded; resume it, then undo it");
      if (m.status === "applied" || m.status === "partial") refuse("This import was applied; undo it from the history instead");
      const next = { ...m, status: "rejected", updatedAt: now() };
      await saveManifest(s, next);
      await pruneManifests(s);
      return structuredClone(s.changesets.get(m.id) ?? next);
    }),

    /**
     * Undoes a history group; when the group is an applied import, its manifest records the undo
     * (undoneAt, undoneBy, how many items were kept because they changed since) and every client
     * hears of it.
     * @param {any} args {groupId, senderId, by}
     */
    undoGroup: async (args) => {
      const a = isObject(args) ? args : {};
      const result = await map.undoGroup(a);
      await enqueue(async () => {
        const s = await load();
        const m = typeof a.groupId === "string" ? s.changesets.get(a.groupId) : null;
        if (!m || (m.status !== "applied" && m.status !== "partial") || !result.parts) return;
        await saveManifest(s, { ...m, undoneAt: now(), undoneBy: cleanName(a.by, "Anonymous"), undoKept: result.conflicts.length, updatedAt: now() });
      });
      return result;
    },

    listChangesets: () => enqueue(async () => {
      const s = await load();
      return structuredClone([...s.changesets.values()].sort((a, b) => b.updatedAt - a.updatedAt));
    }),
  };
}

export { STATUS };
