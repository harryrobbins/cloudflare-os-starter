// The Gatekeeper vendor, in one import for `src/index.ts`. Everything here is reached over RPC from
// the Workshop: the vendor through its service binding (`entrypoint: "GatekeeperVendor"`), and the
// account, verifier and facet class through `ctx.exports`, so they only have to be exported from the
// Worker's main module.

export { SearchAccount, SearchVerifier, describeSearchAccount } from "./account.js";
export { SearchGatekeeper, describeSearchResource, searchAgentCatalog } from "./gatekeeper.js";
export { GatekeeperVendor, describeSearchVendor, searchHomeUrl } from "./vendor.js";
export { FIND_COMMAND, SearchSlashCommands, expandFind } from "./slash.js";
export {
  SEARCH_INDEX_ACTION,
  SearchSessionImpl,
  absoluteUrl,
  batchFor,
  boundedLimit,
  describeQuery,
  gadgetDocumentId,
  partitionScope,
  plainSnippet,
  prepareGadgetDocument,
  runSearch,
  toSearchHit,
  type PendingIndexChange,
  type SearchActionStore,
} from "./session.js";
export type * from "./types.js";
