// Ambient types for the gadget server when type-checked outside workerd (tsconfig.json).
declare module "cloudflare:workers" {
  export class DurableObject<Env = any> {
    constructor(ctx: DurableObjectState, env: Env);
    ctx: DurableObjectState;
    env: Env;
  }
}
type DurableObjectState = { storage: any; [key: string]: any };
