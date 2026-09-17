import { PROCGEN_POLICY, PROFILE_CARDINALITIES, type SizeProfile } from "./policy.js";

export interface DatasetResource { scenario: "commerce"; version: "v1"; seed: string; profile: SizeProfile; url: string }

export function parseResourceUrl(input: string): DatasetResource {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Invalid synthetic dataset URL."); }
  const [version, encodedSeed, profile, extra] = url.pathname.slice(1).split("/");
  if (url.protocol !== "procgen:" || url.hostname !== "commerce" || extra !== undefined) throw new Error("Expected procgen://commerce/v1/<seed>/<profile>.");
  if (version !== "v1") throw new Error("Unsupported scenario version. Valid versions: v1.");
  let seed: string;
  try { seed = decodeURIComponent(encodedSeed ?? ""); } catch { throw new Error("Seed encoding is invalid."); }
  if (encodeURIComponent(seed) !== encodedSeed || seed.length > PROCGEN_POLICY.maxSeedLength || !PROCGEN_POLICY.seedPattern.test(seed)) throw new Error("Seed must be 1-64 characters using letters, numbers, dot, dash, or underscore.");
  if (!(profile in PROFILE_CARDINALITIES)) throw new Error("Unsupported size profile. Valid profiles: small, medium.");
  const normalized = `procgen://commerce/v1/${encodeURIComponent(seed)}/${profile}`;
  if (input !== normalized) throw new Error(`Dataset URL is not canonical; use ${normalized}.`);
  return { scenario: "commerce", version: "v1", seed, profile: profile as SizeProfile, url: normalized };
}

export function makeResourceUrl(seed: string, profile: SizeProfile): string {
  return parseResourceUrl(`procgen://commerce/v1/${encodeURIComponent(seed)}/${profile}`).url;
}
