// The Gatekeeper vendor, in one import for `src/index.ts`.
//
// Everything here is reached over RPC from the Workshop, never over HTTP: the entrypoints are named
// in the Workshop's service binding (`entrypoint: "GatekeeperVendor"`), and the account, verifier
// and facet class are resolved through `ctx.exports`, which means they only have to be exported from
// the Worker's main module.

export { ChatAccount, ChatVerifier, describeChatAccount, type ChatAccountProps } from "./account.js";
export {
  ChatGatekeeper,
  chatAgentCatalog,
  describeChatResource,
  type ChatGatekeeperProps,
} from "./gatekeeper.js";
export { GatekeeperVendor, chatHomeUrl, describeChatVendor, CHAT_ICON } from "./vendor.js";
export {
  AGENT_IDENTITY,
  ChatApiError,
  WorkspaceBridge,
  type ChatBridge,
} from "./bridge.js";
export {
  CHAT_POST_ACTION,
  ChatSessionImpl,
  DEFAULT_AGENT_LIMIT,
  MAX_AGENT_CHANNELS,
  MAX_AGENT_LIMIT,
  applyChatPost,
  boundedLimit,
  describeChatPost,
  rejectChatPost,
  revertChatPost,
  type AppliedChatPost,
  type ChatActionStore,
  type ChatSessionDependencies,
  type PendingChatPost,
} from "./session.js";
export type * from "./types.js";
