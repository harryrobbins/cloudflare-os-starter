// The Gatekeeper vendor, in one import for `src/index.ts`.
//
// Everything here is reached over RPC from the Workshop, never over HTTP: the entrypoints are named
// in the Workshop's service binding (`entrypoint: "GatekeeperVendor"`), and the account, verifier
// and facet class are resolved through `ctx.exports`, which means they only have to be exported from
// the Worker's main module.

export { ChatAccount, ChatVerifier, describeChatAccount } from "./account.js";
export { ChatGatekeeper, chatAgentCatalog, describeChatResource } from "./gatekeeper.js";
export { GatekeeperVendor, chatHomeUrl, describeChatVendor } from "./vendor.js";
export { ChatApiError, type ChatBridge } from "./bridge.js";
export {
  ChatSessionImpl,
  MAX_AGENT_LIMIT,
  applyChatPost,
  boundedLimit,
  rejectChatPost,
  revertChatPost,
  type AppliedChatPost,
  type ChatActionStore,
  type PendingChatPost,
} from "./session.js";
export type * from "./types.js";
