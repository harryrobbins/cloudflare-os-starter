import { RecordsClient, type BlueprintRequirement } from './client.ts';

export interface VerifiedViewer {
  subject: string;
  issuer: string;
  audience: string;
  expiresAt: number;
  organisation: string;
}
export interface BindingGrant {
  datastore: string;
  binding: string;
  subject: string;
  expiresAt: number;
  /** A per-viewer scoped credential, obtained from the enrolled host's credential broker. */
  token: string;
}
export interface ViewerBindingOptions {
  url: string;
  datastore: string;
  binding: string;
  organisation: string;
  issuer: string;
  audience: string;
  assertion: () => Promise<string>;
  /** Must cryptographically verify signature, trusted keys, issuer, audience and expiry. No default bypass. */
  verify: (assertion: string) => Promise<VerifiedViewer>;
  /** Host-owned broker must authorize this viewer and mint an individually revocable binding credential. */
  exchange: (viewer: VerifiedViewer, datastore: string, binding: string) => Promise<BindingGrant>;
  requirement: BlueprintRequirement;
  fetch?: typeof fetch;
}

export interface ViewerReadBinding {
  readonly requirement: BlueprintRequirement;
  records(query?: { entity?: string; id?: string; after?: string; limit?: number }): Promise<unknown>;
  snapshot(limit?: number): Promise<{ records: unknown[]; seq: number; permission_epoch: number; complete: true }>;
}
/** Read-only integration seam. Host writes require the separate exact-intent approval contract. */
export async function bindViewer(options: ViewerBindingOptions): Promise<ViewerReadBinding> {
  let grant: BindingGrant | undefined;
  const client = new RecordsClient({
    url: options.url, datastore: options.datastore, fetch: options.fetch,
    token: async () => {
      if (grant && grant.expiresAt > Date.now() / 1000 + 30) return grant.token;
      const viewer = await options.verify(await options.assertion());
      if (viewer.issuer !== options.issuer || viewer.audience !== options.audience || viewer.organisation !== options.organisation || !viewer.subject || !Number.isFinite(viewer.expiresAt) || viewer.expiresAt <= Date.now() / 1000) throw new Error('Viewer assertion is not valid for this binding');
      const candidate = await options.exchange(viewer, options.datastore, options.binding);
      if (candidate.subject !== viewer.subject || candidate.datastore !== options.datastore || candidate.binding !== options.binding || !candidate.token || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt > viewer.expiresAt || candidate.expiresAt <= Date.now() / 1000) throw new Error('Broker returned an invalid viewer binding');
      grant = candidate; return grant.token;
    },
  });
  const module = await client.bind(options.requirement);
  return { requirement: module.requirement, records: query => module.records(query), snapshot: limit => module.snapshot(limit) };
}
