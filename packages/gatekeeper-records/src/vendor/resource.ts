// Resource URLs name one datastore and the operation scopes a gadget binding asks for:
//
//     records://datastore/<datastore uuid>/<scope>,<scope>,...
//
// The URL is a request, not a grant. The binding row created on first use holds the scopes the
// connecting person actually has; the server re-derives authority on every call.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { RECORD_SCOPES, RecordsError, type RecordScope } from "@records/contracts";

export const DATASTORE_URL_PATTERN = "records://datastore/*";
export const READ_SCOPES: RecordScope[] = ["projects.read", "issues.read"];

const URL_RE = /^records:\/\/datastore\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/([a-z.,]*))?\/?$/;

export type DatastoreResource = { datastoreId: string; scopes: RecordScope[] };

export function datastoreUrl(datastoreId: string, scopes: readonly RecordScope[]): string {
  return `records://datastore/${datastoreId}/${[...new Set(scopes)].toSorted().join(",")}`;
}

export function parseDatastoreUrl(url: string): DatastoreResource {
  const match = URL_RE.exec(url.trim());
  if (!match) throw new RecordsError("validation_failed", "Not a Records datastore URL (records://datastore/<id>/<scopes>).");
  const requested = match[2] ? match[2].split(",").filter(Boolean) : READ_SCOPES;
  const unknown = requested.filter((s) => !(RECORD_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new RecordsError("validation_failed", `Unknown scopes: ${unknown.join(", ")}.`);
  // Describing the binding needs projects.read, so every binding carries it.
  return { datastoreId: match[1]!, scopes: [...new Set(["projects.read", ...requested] as RecordScope[])].toSorted() };
}

export const DATASTORE_RESOURCE: SupportedResource = {
  urlPattern: DATASTORE_URL_PATTERN,
  title: "Organisation datastore",
  description: "One organisation-owned Projects datastore, with the operations you choose.",
};
