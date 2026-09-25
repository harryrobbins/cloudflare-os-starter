// Deployment configuration: which Records service this Worker talks to, which datastores an
// operator approved for gadgets, and the resource URLs gadgets bind to.
//
// Datastore credentials live only in the RECORDS_SERVICE_DATASTORES Worker secret. They never
// reach a configurator, gadget, agent or log: sessions receive data, never credentials.

export const DATASTORE_URL_PATTERN = "records-service://datastore/*";
export type Access = "read" | "write";

export interface ApprovedDatastore {
  id: string;
  label: string;
  /** The Records datastore credential (rk_…). Server-side only. */
  key: string;
}

export interface DatastoreResource {
  datastore: string;
  moduleId: string;
  apiMajor: number;
  access: Access;
  url: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODULE = /^[a-z][a-z0-9_-]{0,62}$/;
const KEY = /^[\x21-\x7e]{16,512}$/;

/** The service origin: https only, no path, query or credentials. `http:` only for loopback tests. */
export function serviceUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("RECORDS_SERVICE_URL is not configured."); }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("RECORDS_SERVICE_URL must be a bare https origin.");
  }
  return url.origin;
}

/**
 * Parses the RECORDS_SERVICE_DATASTORES secret: a JSON array of `{ id, label, key }`. Errors never
 * echo the secret's content.
 */
export function approvedDatastores(secret: string | undefined): ApprovedDatastore[] {
  if (!secret) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch { throw new Error("RECORDS_SERVICE_DATASTORES is not valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > 50) throw new Error("RECORDS_SERVICE_DATASTORES must be an array of at most 50 datastores.");
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const value = entry as Partial<ApprovedDatastore> | null;
    const id = typeof value?.id === "string" ? value.id.toLowerCase() : "";
    if (!UUID.test(id) || seen.has(id)) throw new Error(`RECORDS_SERVICE_DATASTORES[${index}] needs a unique datastore UUID.`);
    if (typeof value?.key !== "string" || !KEY.test(value.key)) throw new Error(`RECORDS_SERVICE_DATASTORES[${index}] needs a credential.`);
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 80) : `Datastore ${id.slice(0, 8)}`;
    seen.add(id);
    return { id, label, key: value.key };
  });
}

export function scopesFor(moduleId: string, access: Access): string[] {
  return access === "write" ? [`${moduleId}.read`, `${moduleId}.write`] : [`${moduleId}.read`];
}

export function datastoreUrl(datastore: string, moduleId: string, apiMajor: number, access: Access): string {
  return parseDatastoreUrl(`records-service://datastore/${datastore}/${moduleId}/v${apiMajor}/${access}`).url;
}

/** records-service://datastore/<uuid>/<module>/v<major>/<read|write>, canonical form only. */
export function parseDatastoreUrl(input: string): DatastoreResource {
  const match = /^records-service:\/\/datastore\/([^/]+)\/([^/]+)\/v([1-9]\d{0,3})\/(read|write)\/?$/.exec(input.trim());
  if (!match || !UUID.test(match[1]!.toLowerCase()) || !MODULE.test(match[2]!)) {
    throw new Error("Not a Records service datastore URL (records-service://datastore/<id>/<module>/v<major>/<read|write>).");
  }
  const datastore = match[1]!.toLowerCase(), moduleId = match[2]!, apiMajor = Number(match[3]), access = match[4] as Access;
  return { datastore, moduleId, apiMajor, access, url: `records-service://datastore/${datastore}/${moduleId}/v${apiMajor}/${access}` };
}
