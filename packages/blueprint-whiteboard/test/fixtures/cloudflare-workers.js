// Node stand-in for `cloudflare:workers`, so plain-Node tests can construct the real Gadget class
// (src/server/index.js) over in-memory storage. Workerd tests use the real module.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
