// Node stand-in for `cloudflare:workers`, so the Gadget class runs in plain vitest (vitest.config.ts
// aliases the import here). Real workerd behaviour is covered by test/server.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
