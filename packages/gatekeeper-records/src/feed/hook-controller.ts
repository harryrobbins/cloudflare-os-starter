// HookController handed to ApprovalQueue.bindHook(). Its props say which binding the hook is for;
// the Workshop calls enable() once the owner approves, and disable() when it is removed.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { HookController, HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";

import type { RecordsChangeHook } from "../vendor/types.js";

export type HookControllerProps = { orgId: string; datastoreId: string; bindingId: string };

@validateRpc()
export class RecordsHookController
  extends WorkerEntrypoint<Cloudflare.Env, HookControllerProps>
  implements HookController<RecordsChangeHook & Rpc.RpcTargetBranded>
{
  async enable(initiator: Fetcher<HookInitiator<RecordsChangeHook & Rpc.RpcTargetBranded>>, target: HookTargetMetadata): Promise<void> {
    const { orgId, datastoreId, bindingId } = this.ctx.props;
    await this.ctx.exports.DatastoreFeed.getByName(datastoreId).register(orgId, bindingId, initiator as never, target);
  }

  async disable(): Promise<void> {
    await this.ctx.exports.DatastoreFeed.getByName(this.ctx.props.datastoreId).unregister(this.ctx.props.bindingId);
  }
}
