// Browser stand-in for `cloudflare:workers` (mapped by the import map in index.html), so the
// harness can run the real Gadget class from src/server/index.js.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
