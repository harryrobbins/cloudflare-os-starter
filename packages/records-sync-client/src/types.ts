// Shared shapes for the store, the mutators and the sync client.
//
// Only types are imported from @records/contracts: its runtime entry pulls in zod, and this package
// is bundled into gadget clients where every kilobyte counts.

import type { PrincipalRef } from "@records/contracts";

/** Read access to a key/value snapshot (server state or the optimistic view). */
export interface ReadTx {
  get<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  /** Entries whose key starts with `prefix`, in key order. */
  scan<T = unknown>(prefix: string): Array<[key: string, value: T]>;
}

/**
 * What a mutator runs against. Writes are all-or-nothing: if the mutator throws, none of its puts
 * or deletes take effect. Values are treated as immutable: never modify an object returned by
 * `get`; put a new one.
 */
export interface WriteTx extends ReadTx {
  put(key: string, value: unknown): void;
  del(key: string): void;
  readonly context: MutationContext;
}

/**
 * Facts a mutator needs that are not in its args. In the browser they come from the sync client;
 * a server running the same mutators supplies its own (and `allocateIssueNumber`).
 */
export type MutationContext = {
  /** The principal making the change: the signed-in viewer in the browser. */
  principal: PrincipalRef;
  /** Milliseconds since the epoch at which the mutation was made. Stable across replays. */
  timestamp: number;
  /**
   * Authoritative number allocation. Absent in the browser, where created issues get the
   * placeholder number 0 and key `<PROJECT>-?` until the server's version arrives by pull.
   */
  allocateIssueNumber?: (projectId: string) => number;
};

/** A pure function that predicts (browser) or performs (server) one command. */
export type Mutator<A = any> = (tx: WriteTx, args: A) => void;
export type MutatorDefs = Record<string, Mutator<any>>;
export type MutatorArgs<F> = F extends Mutator<infer A> ? A : never;

/** Store/patch keys. Kept local rather than importing `entityKey` so zod stays out of the bundle. */
export const WORKFLOW_KEY = "meta/workflow";
export const projectKey = (id: string): string => `project/${id}`;
export const issueKey = (id: string): string => `issue/${id}`;
export const commentKey = (id: string): string => `comment/${id}`;
