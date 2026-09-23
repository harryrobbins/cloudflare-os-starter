// Module manifests and blueprint service requirements (plan §4).
//
// API versions and physical migration versions are distinct: several migrations may preserve one
// API major. A blueprint declares the API major it speaks, the features it needs and the scopes it
// asks for; it never names a datastore, credential or membership.

import { z } from "zod";

import { RECORD_SCOPES, RecordScopeSchema } from "./permissions.js";

export const ModuleManifestSchema = z.object({
  moduleId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  apiVersions: z.array(z.number().int().min(1)).min(1),
  features: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{1,40}$/)),
  schema: z.string(),
  migrations: z.array(z.object({ id: z.string(), checksum: z.string().regex(/^[0-9a-f]{64}$/) })),
});
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

/** Declared in a blueprint's sidecar metadata; contains no live grants. */
export const ServiceRequirementSchema = z
  .object({
    service: z.literal("records"),
    moduleId: z.string(),
    apiMajor: z.number().int().min(1),
    features: z.array(z.string()).default([]),
    scopes: z.array(RecordScopeSchema).min(1),
  })
  .strict();
export type ServiceRequirement = z.infer<typeof ServiceRequirementSchema>;

/** The Projects module's API contract, version 1. */
export const PROJECTS_API_V1 = {
  moduleId: "projects",
  apiMajor: 1,
  features: ["issues", "comments", "workflow", "custom_fields"],
  scopes: RECORD_SCOPES,
} as const;

export type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; reason: "module" | "api_major" | "feature" | "scope"; detail: string };

/** Can a datastore of `offered` serve a blueprint requiring `required`? Checked server-side at bind. */
export function checkCompatibility(
  required: ServiceRequirement,
  offered: { moduleId: string; apiVersions: readonly number[]; features: readonly string[] },
  grantableScopes: readonly string[],
): CompatibilityResult {
  if (required.moduleId !== offered.moduleId) {
    return { compatible: false, reason: "module", detail: `needs module ${required.moduleId}` };
  }
  if (!offered.apiVersions.includes(required.apiMajor)) {
    return { compatible: false, reason: "api_major", detail: `needs API v${required.apiMajor}` };
  }
  const missing = required.features.filter((f) => !offered.features.includes(f));
  if (missing.length) return { compatible: false, reason: "feature", detail: `missing ${missing.join(", ")}` };
  const extra = required.scopes.filter((s) => !grantableScopes.includes(s));
  if (extra.length) return { compatible: false, reason: "scope", detail: `cannot grant ${extra.join(", ")}` };
  return { compatible: true };
}
