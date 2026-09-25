// Minimal stand-in for `cloudflare:workers` under Node tests.
export class RpcTarget {}
export class RpcStub<T> { constructor(readonly value: T) {} }
export class DurableObject<Env = unknown, Props = unknown> {
  constructor(readonly ctx: { props: Props }, readonly env: Env) {}
}
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  constructor(readonly ctx: { props: Props }, readonly env: Env) {}
}
