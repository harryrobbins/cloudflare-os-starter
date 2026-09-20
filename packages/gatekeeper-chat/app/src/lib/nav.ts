// Routes, as the one mapping between the contract's absolute paths and the router's own.
//
// `permalink()` and `apiPath()` produce paths that include `/gatekeeper/chat`, because that is what a
// browser and the Worker both need. TanStack Router is mounted with that prefix as its `basepath`, so
// its `to` values must *not* repeat it. Converting in one place is what stops a copied permalink from
// navigating to `/gatekeeper/chat/gatekeeper/chat/...`.

import { CHAT_PREFIX, permalink } from "../contract.js";

/** Strips the mount prefix from an absolute app path, giving a router path. */
export function toRouterPath(absolutePath: string): string {
  if (!absolutePath.startsWith(CHAT_PREFIX)) return absolutePath;
  const rest = absolutePath.slice(CHAT_PREFIX.length);
  return rest.length === 0 ? "/" : rest;
}

/** The absolute path for a permalink, for copying to the clipboard or posting to the shell. */
export function permalinkUrl(channelId: string, messageId: string): string {
  const path = permalink(channelId, messageId);
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

export const ROUTE = {
  channel: "/c/$channelId",
  thread: "/c/$channelId/t/$rootId",
  message: "/c/$channelId/m/$messageId",
  threads: "/threads",
  mentions: "/mentions",
  drafts: "/drafts",
  search: "/search",
  dm: "/dm/$userId",
  browse: "/browse",
  people: "/people",
  settings: "/settings",
} as const;
