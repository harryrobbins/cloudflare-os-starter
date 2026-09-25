/**
 * A Records service datastore connected to this gadget.
 *
 * Records (https://records.surprisingly.ltd) is a standards-based app datastore: each datastore
 * installs one module (for example `work` or `messaging`) at one API major. Records belong to the
 * datastore, not to any gadget, so several gadgets connected to the same datastore see the same
 * data. Reads are current reads of the service. Writes are module commands; each one must be
 * requested by a signed-in viewer through the Workshop and is applied only after approval.
 */
export interface RecordsServiceSession {
  /** This connection: which datastore, module and access it was granted. No credentials. */
  connection(): Promise<RecordsConnection>;
  /** The datastore's installed module, granted scopes and permission epoch. */
  describe(): Promise<RecordsDatastoreDescription>;
  /** The installed module's public model: its profile and one JSON Schema per entity. */
  model(): Promise<RecordsModel>;
  /**
   * A bounded page of current records in server UUID order. `after` is the id of the last record
   * of the previous page; an empty page ends traversal. Pages are not a consistent snapshot.
   */
  records(query?: RecordsQuery): Promise<RecordsPage>;
  /**
   * An atomic, complete snapshot with a journal watermark (`seq`) and permission epoch. Fails
   * with `too_large` when the datastore holds more than `limit` records (default 1,000, max 5,000).
   */
  snapshot(limit?: number): Promise<RecordsSnapshot>;
  /**
   * Journal entries after `after` (a snapshot's or earlier page's `seq`/`cursor`), at most 100
   * per page. Pass the last `permission_epoch`; `reset_required` means discard cached records and
   * take a new snapshot.
   */
  changes(after?: number, epoch?: number): Promise<RecordsChanges>;
  /**
   * Request a module command as the signed-in viewer. The browser mints `viewerAssertion` with
   * `gadget.$createViewerAssertion(bindingName, digest)` where `digest` is the lowercase hex
   * SHA-256 of the canonical JSON (object keys sorted, no whitespace) of the
   * {@link RecordsCommandIntent} for exactly this call. The result is normally `pending`: poll
   * {@link getOutcome}. Keep `idempotencyKey` for retries of the same logical change.
   */
  command(command: string, input: Record<string, unknown>, options: RecordsCommandOptions): Promise<RecordsCommandOutcome>;
  /** The outcome of an earlier command. */
  getOutcome(actionId: number): Promise<RecordsCommandOutcome>;
}

export interface RecordsConnection {
  /** Canonical connection URL, records-service://datastore/<id>/<module>/v<major>/<access>. */
  url: string;
  datastore: string;
  /** Stable identifier of this gadget connection; part of every command intent. */
  binding: string;
  /** Operator-chosen display label for the datastore. */
  label: string;
  moduleId: string;
  apiMajor: number;
  /** "read" connections cannot request commands. */
  access: "read" | "write";
  /** Scopes this connection may use, e.g. ["work.read", "work.write"]. */
  scopes: string[];
}

export interface RecordsModuleManifest {
  id: string;
  api_majors: number[];
  scopes: string[];
  entities?: string[];
  commands?: string[];
  version?: string;
  profile?: RecordsProfile;
}

export interface RecordsDatastoreDescription {
  id: string;
  module_id: string;
  api_major: number;
  permission_epoch: number;
  granted_scopes: string[];
  modules: RecordsModuleManifest[];
}

export interface RecordsProfileField {
  /** Semantic term IRI, e.g. https://schema.org/name. */
  term?: string;
  type?: string;
  required?: boolean;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  [key: string]: unknown;
}

export interface RecordsProfile {
  id?: string;
  version?: string;
  vocabulary?: { id: string; version: string };
  entities: Record<string, { term?: string; fields: Record<string, RecordsProfileField> }>;
}

export interface RecordsModel {
  moduleId: string;
  apiMajor: number;
  profile: RecordsProfile | null;
  /** Generated JSON Schema per installed entity; absent when the service has none. */
  schemas: Record<string, unknown>;
}

export interface RecordsQuery {
  entity?: string;
  /** Exact record UUID. */
  id?: string;
  /** Record UUID after which the page starts. */
  after?: string;
  /** 1-500, default 100. */
  limit?: number;
}

export interface RecordsRecord {
  id: string;
  entity: string;
  /** The journal sequence of the record's last change; pass it as `revision` to update. */
  revision: number;
  data: Record<string, unknown>;
}

export interface RecordsPage { records: RecordsRecord[]; seq: number; permission_epoch: number }
export interface RecordsSnapshot { records: RecordsRecord[]; seq: number; permission_epoch: number; complete: true }

export interface RecordsChange {
  seq: number;
  ordinal: number;
  entity: string;
  record_id: string;
  revision: number;
  /** The record's data after this change. */
  data: Record<string, unknown>;
}

export interface RecordsChanges { changes: RecordsChange[]; cursor: number; permission_epoch: number }

export interface RecordsCommandOptions {
  viewerAssertion: string;
  /** 1-128 printable ASCII characters; reuse it when retrying the same change. */
  idempotencyKey: string;
  /** Required by update commands: the record's current revision. Omit for creates. */
  revision?: number;
}

/** What the viewer asserts. Hash its canonical JSON; see {@link RecordsServiceSession.command}. */
export interface RecordsCommandIntent {
  datastore: string;
  binding: string;
  moduleId: string;
  apiMajor: number;
  command: string;
  input: Record<string, unknown>;
  /** The `revision` option, or null when omitted. */
  expectedRevision: number | null;
  idempotencyKey: string;
}

export type RecordsCommandOutcome =
  | { status: "pending"; actionId: number }
  | { status: "applied"; result: { record: RecordsRecord; seq: number; permission_epoch: number } }
  | { status: "rejected"; reason: string };

/**
 * Errors cross RPC as `Error("<code>: <detail>")`. Codes: `forbidden`, `not_found`,
 * `invalid_request`, `conflict`, `reset_required`, `stale_revision`, `revision_required`,
 * `too_large`, `read_only`, `unavailable`.
 */
export type RecordsErrorCode =
  | "forbidden" | "not_found" | "invalid_request" | "conflict" | "reset_required" | "stale_revision"
  | "revision_required" | "too_large" | "read_only" | "unavailable";
