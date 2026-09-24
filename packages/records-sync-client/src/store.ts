// The client's record store: authoritative server state plus an optimistic view.
//
//   server state  = what the last pulls said (patches applied in cookie order)
//   view          = server state with every still-pending mutation replayed on top
//
// Readers only ever see the view. Subscribers are told once per batch (a local mutation, or a pull
// plus its replay), with the keys whose visible value changed.

import type { PatchOp } from "@records/contracts";

import type { MutationContext, ReadTx, WriteTx } from "./types.js";

export type StoreChange = { changedKeys: string[] };
export type StoreListener = (change: StoreChange) => void;

const DELETED = Symbol("deleted");

function scanMap<T>(map: ReadonlyMap<string, unknown>, prefix: string, overlay?: Map<string, unknown>): Array<[string, T]> {
  const keys = new Set<string>();
  for (const k of map.keys()) if (k.startsWith(prefix)) keys.add(k);
  if (overlay) for (const k of overlay.keys()) if (k.startsWith(prefix)) keys.add(k);
  const out: Array<[string, T]> = [];
  for (const k of [...keys].sort()) {
    const v = overlay?.has(k) ? overlay.get(k) : map.get(k);
    if (v !== DELETED && v !== undefined) out.push([k, v as T]);
  }
  return out;
}

class MapRead implements ReadTx {
  constructor(private readonly map: ReadonlyMap<string, unknown>) {}
  get<T = unknown>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  scan<T = unknown>(prefix: string): Array<[string, T]> {
    return scanMap<T>(this.map, prefix);
  }
}

/** Buffers writes over a base map; `commit` applies them only once the mutator returned. */
class OverlayTx implements WriteTx {
  private readonly writes = new Map<string, unknown>();
  constructor(private readonly base: Map<string, unknown>, readonly context: MutationContext) {}

  get<T = unknown>(key: string): T | undefined {
    if (this.writes.has(key)) {
      const v = this.writes.get(key);
      return v === DELETED ? undefined : (v as T);
    }
    return this.base.get(key) as T | undefined;
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  scan<T = unknown>(prefix: string): Array<[string, T]> {
    return scanMap<T>(this.base, prefix, this.writes);
  }
  put(key: string, value: unknown): void {
    if (value === undefined) throw new TypeError("put: value must not be undefined");
    this.writes.set(key, value);
  }
  del(key: string): void {
    this.writes.set(key, DELETED);
  }
  writtenKeys(): string[] {
    return [...this.writes.keys()];
  }
  commit(): void {
    for (const [k, v] of this.writes) {
      if (v === DELETED) this.base.delete(k);
      else this.base.set(k, v);
    }
  }
}

/** Structural equality for JSON-shaped values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** One step of a replay: run `fn` in its own transaction. */
export type ReplayStep = { context: MutationContext; run: (tx: WriteTx) => void; onError?: (err: unknown) => void };

export class RecordStore implements ReadTx {
  private readonly serverState = new Map<string, unknown>();
  private view = new Map<string, unknown>();
  private readonly listeners = new Set<StoreListener>();

  // ---- reads (the optimistic view) ----------------------------------------------------------

  get<T = unknown>(key: string): T | undefined {
    return this.view.get(key) as T | undefined;
  }
  has(key: string): boolean {
    return this.view.has(key);
  }
  scan<T = unknown>(prefix: string): Array<[string, T]> {
    return scanMap<T>(this.view, prefix);
  }
  /** Values only, in key order. */
  values<T = unknown>(prefix: string): T[] {
    return this.scan<T>(prefix).map(([, v]) => v);
  }
  /** Read-only access to the confirmed server state (no local guesses). */
  get server(): ReadTx {
    return new MapRead(this.serverState);
  }
  /** Copy of the view, for tests and debugging. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.view.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- writes (used by the sync client) -----------------------------------------------------

  /** Applies a pull patch to server state only. Call `rebase` afterwards to refresh the view. */
  applyServerPatch(patch: readonly PatchOp[]): void {
    for (const op of patch) {
      if (op.op === "clear") this.serverState.clear();
      else if (op.op === "put") this.serverState.set(op.key, op.value);
      else if (op.op === "del") this.serverState.delete(op.key);
    }
  }

  /**
   * Applies one local mutation on top of the current view and notifies subscribers once.
   * Throws (leaving the view untouched) if the mutator throws.
   */
  applyLocal(step: ReplayStep): void {
    const tx = new OverlayTx(this.view, step.context);
    step.run(tx);
    const before = new Map<string, unknown>();
    const touched = tx.writtenKeys();
    for (const k of touched) before.set(k, this.view.get(k));
    tx.commit();
    const changed = touched.filter((k) => !deepEqual(before.get(k), this.view.get(k)));
    this.emit(changed);
  }

  /**
   * Rebuilds the view as server state plus `steps` replayed in order (a step that throws
   * contributes nothing), then notifies subscribers once with the keys that visibly changed.
   */
  rebase(steps: readonly ReplayStep[]): void {
    const next = new Map(this.serverState);
    for (const step of steps) {
      const tx = new OverlayTx(next, step.context);
      try {
        step.run(tx);
        tx.commit();
      } catch (err) {
        step.onError?.(err);
      }
    }
    const old = this.view;
    this.view = next;
    const changed: string[] = [];
    for (const [k, v] of next) if (!deepEqual(old.get(k), v)) changed.push(k);
    for (const k of old.keys()) if (!next.has(k)) changed.push(k);
    this.emit(changed);
  }

  private emit(changedKeys: string[]): void {
    if (changedKeys.length === 0) return;
    const change = { changedKeys: changedKeys.sort() };
    for (const l of [...this.listeners]) {
      try {
        l(change);
      } catch (err) {
        // A broken listener must not break sync.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
