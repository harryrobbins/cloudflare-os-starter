// The opaque verifier the Workshop passes back to `addObserver()`. The Workshop only ever hands a
// verifier back to the gatekeeper that minted it, so its `identity()` can be trusted there: it
// reports the principal bound into this account at the Access-verified connect flow.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";

export type VerifiedIdentity = { orgId: string; principalId: string };

@validateRpc()
export class RecordsVerifier extends WorkerEntrypoint<Cloudflare.Env, VerifiedIdentity> implements GatekeeperUserVerifier {
  identity(): VerifiedIdentity {
    return { orgId: this.ctx.props.orgId, principalId: this.ctx.props.principalId };
  }
}
