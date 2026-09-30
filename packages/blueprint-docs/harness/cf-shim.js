// Stands in for "cloudflare:workers" when the real Docs server (src/server/index.js) is bundled
// for the browser harness.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
