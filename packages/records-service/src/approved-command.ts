import type { VerifiedViewer } from './connector.ts';

export interface CommandIntent {
  datastore: string; binding: string; moduleId: string; apiMajor: number; command: string;
  input: unknown; expectedRevision: number | null; idempotencyKey: string;
}
export interface IntentApproval { subject: string; digest: string; approved: boolean; expiresAt: number }
export interface VerifiedIntent extends VerifiedViewer { digest: string }
export interface ApprovedCommandHost {
  datastore: string; binding: string; organisation: string; issuer: string; audience: string;
  /** Obtain a fresh assertion whose signed claims include this complete intent digest. */
  assertion(intent: Readonly<CommandIntent>, digest: string): Promise<string>;
  /** Cryptographically verify trusted issuer keys, audience, expiry, viewer and signed digest. */
  verifyIntent(assertion: string, digest: string): Promise<VerifiedIntent>;
  /** Host-owned approval UI/policy; approval must be tied to this viewer and exact digest. */
  approveIntent(viewer: VerifiedIntent, intent: Readonly<CommandIntent>, digest: string): Promise<IntentApproval>;
  /** Trusted server broker executes only this approved intent. Never return service credentials to an app. */
  executeIntent(viewer: VerifiedIntent, intent: Readonly<CommandIntent>, approval: IntentApproval): Promise<unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new Error('Command intent must contain only JSON values');
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
}
export async function intentDigest(intent: CommandIntent): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(intent));
  if (bytes.length > 65536) throw new Error('Command intent exceeds size limit');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
/** OS-neutral host integration contract. Deploying an enrolled verifier/approval/broker remains host work. */
export async function executeApprovedCommand(host: ApprovedCommandHost, command: Omit<CommandIntent, 'datastore' | 'binding'>): Promise<unknown> {
  // Canonical deep copy prevents an app mutating input while the approval dialog is pending.
  const intent: CommandIntent = JSON.parse(canonical({ ...command, datastore: host.datastore, binding: host.binding }));
  freeze(intent);
  const digest = await intentDigest(intent);
  const viewer = await host.verifyIntent(await host.assertion(intent, digest), digest);
  const now = () => Date.now() / 1000;
  if (!viewer.subject || viewer.issuer !== host.issuer || viewer.audience !== host.audience || viewer.organisation !== host.organisation || viewer.digest !== digest || !Number.isFinite(viewer.expiresAt) || viewer.expiresAt <= now()) throw new Error('Viewer assertion does not authorize this exact intent');
  const approval = await host.approveIntent(viewer, intent, digest);
  if (!approval.approved || approval.digest !== digest || approval.subject !== viewer.subject || !Number.isFinite(approval.expiresAt) || approval.expiresAt > viewer.expiresAt || approval.expiresAt <= now() || viewer.expiresAt <= now()) throw new Error('Exact command intent approval required');
  return host.executeIntent(viewer, intent, approval);
}
