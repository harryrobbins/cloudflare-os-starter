// Stands in for the Workshop's `ExternalMessageGateway` (workshop-backend/src/external-message-gateway.ts)
// in the agent suites, bound to the test Worker as WORKSHOP_GATEWAY exactly the way deploy.ts binds
// the real one: a named entrypoint with `props: { source: "chat" }`.
//
// What it answers is chosen by the caller's account name, so suites running in parallel against this
// one Worker never have to share a mode switch:
//
//   throw*    every call throws (the Workshop is down)
//   flaky*    the first call for a messageKey throws, later ones are accepted
//   nomodel*  { accepted: false } with the Workshop's own "needs an AI model" wording
//   anything else is accepted, and the reply target is kept so `Control.respond` can answer later
//
// Like the real Overseer it keeps the target in Durable Object storage past the call (both Workers
// run with `allow_irrevocable_stub_storage`), then answers through a stub read back from storage in a
// later request -- which is also the only way to use it from another request at all. It stores the
// target as received, without `dup()`: what the chat Worker passes is a `ctx.exports` service stub,
// which is the only kind of stub the runtime will persist, and a service stub has no `dup()` (the
// call becomes a pipelined RPC and the store then fails on the RpcPromise) and no `Symbol.dispose`.
// Measured under this suite's workerd; the Overseer is patched to match (see the README's Agent
// section). Plain JavaScript because auxiliary Workers are handed straight to Miniflare and never
// see Vite.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const calls = [];
const attempts = new Map();

/** The Overseer's `gadgetResponseDeliveries`, reduced to a key and a stored stub. */
export class TargetStore extends DurableObject {
  async keep(messageKey, target) {
    await this.ctx.storage.put(messageKey, target);
  }

  async respond(messageKey, text) {
    const target = await this.ctx.storage.get(messageKey);
    if (target === undefined) throw new Error(`No reply target was kept for ${messageKey}.`);
    await target.onGadgetResponse({ text });
  }
}

function store(env) {
  return env.TARGETS.get(env.TARGETS.idFromName("targets"));
}

export class ExternalMessageGateway extends WorkerEntrypoint {
  async submitExternalMessage(input) {
    const source = this.ctx.props?.source;
    if (!source) throw new Error("ExternalMessageGateway source prop is required.");
    const { chatGatewayRpcTarget, ...rest } = input;
    calls.push({ ...rest, source, hasTarget: chatGatewayRpcTarget !== undefined });
    const n = (attempts.get(input.messageKey) ?? 0) + 1;
    attempts.set(input.messageKey, n);

    if (input.callerEmail.startsWith("throw")) throw new Error("The Workshop is unavailable.");
    if (input.callerEmail.startsWith("flaky") && n === 1) throw new Error("A transient failure.");
    if (input.callerEmail.startsWith("nomodel")) {
      return {
        accepted: false,
        message: "Your Cloudflare OS account needs an AI model configured before it can respond.",
      };
    }
    await store(this.env).keep(input.messageKey, chatGatewayRpcTarget);
    return { accepted: true, chatPath: `/workspace/${source}-${input.gadgetKey}?chat=1` };
  }
}

export class Control extends WorkerEntrypoint {
  /** Every submission whose messageKey starts with `prefix`, without the target. */
  calls(prefix) {
    return calls.filter((call) => call.messageKey.startsWith(prefix));
  }

  /** Delivers an answer through the kept target, as the Overseer would. Callable more than once. */
  async respond(messageKey, text) {
    await store(this.env).respond(messageKey, text);
  }
}

export default {
  fetch() {
    return new Response("mock workshop", { status: 404 });
  },
};
