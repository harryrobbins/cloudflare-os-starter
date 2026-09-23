// `ChatAgentReply`: where the Workshop delivers the Agent's answer to one question.
//
// The agent outbox (src/do/agent.ts) mints one of these per question with `ctx.exports`, carrying the
// question's ids in its props, and hands it to the Workshop's `ExternalMessageGateway` as the
// `chatGatewayRpcTarget`. The Workshop's Overseer `dup()`s it into durable storage (both Workers run
// with `allow_irrevocable_stub_storage`) and calls `onGadgetResponse` once the workspace agent has
// finished -- possibly more than once, because delivery is retried until it is acknowledged, and
// possibly after this Worker has been redeployed. The props are therefore the whole state: which
// object, which question, which attempt at it.
//
// The entrypoint is reachable only as a stub this Worker minted: it has no route, and nothing else can
// name it. It still validates what it is handed (capnweb-validate), and the Durable Object checks the
// message key against the question before posting anything.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GadgetResponse } from "@gadgets/workshop-shared/external-message-gateway";

/** Imbued by `workshopGateway()` in src/workspace.ts. */
export type ChatAgentReplyProps = {
  /** `ChatWorkspace` id, as a string: tests address their own objects, production has one. */
  workspaceId: string;
  /** The asking message. */
  requestId: string;
  /** The gateway messageKey this stub was minted for: the request id, plus `.<n>` after a retry. */
  messageKey: string;
};

@validateRpc()
export class ChatAgentReply extends WorkerEntrypoint<Cloudflare.Env, ChatAgentReplyProps> {
  /** Posts the answer as the Agent. Idempotent; throws only when a later delivery could succeed. */
  async onGadgetResponse(response: GadgetResponse): Promise<void> {
    const { workspaceId, requestId, messageKey } = this.ctx.props;
    const workspace = this.env.CHAT_WORKSPACE.get(this.env.CHAT_WORKSPACE.idFromString(workspaceId));
    await workspace.deliverAgentReply(requestId, messageKey, response.text);
  }
}
