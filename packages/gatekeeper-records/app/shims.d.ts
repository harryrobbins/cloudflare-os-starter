// The page imports Worker modules for their types only (DataManagementApi). This stands in for the
// Workers runtime module so the SPA type-check need not load the Workers type definitions.
declare module 'cloudflare:workers' {
  export class RpcTarget {}
}
