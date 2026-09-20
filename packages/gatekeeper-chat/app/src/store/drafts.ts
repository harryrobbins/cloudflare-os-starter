// Drafts, per conversation, in localStorage.
//
// localStorage and not IndexedDB, and drafts and nothing else: the plan is explicit that message
// bodies must not be cached locally in v1 until shared-device and sign-out behaviour is designed. A
// draft is the user's own unsent text, which is a different risk, and is what every chat app keeps.
//
// Every access is wrapped: in a private window, with site data blocked, or during a thumbnail capture,
// the accessor itself can throw, and a draft is never important enough to break the app over.

export const DRAFTS_KEY = "chat.drafts.v1";
/** Drafts older than this are dropped on load, so an abandoned one does not haunt a conversation. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface Draft {
  readonly body: string;
  readonly updatedAt: number;
}

/** A conversation is a channel, or a thread inside one; each keeps its own draft. */
export function conversationKey(channelId: string, rootId?: string | null): string {
  return rootId === undefined || rootId === null ? channelId : `${channelId}:${rootId}`;
}

export function parseConversationKey(key: string): { channelId: string; rootId: string | null } {
  const index = key.indexOf(":");
  if (index === -1) return { channelId: key, rootId: null };
  return { channelId: key.slice(0, index), rootId: key.slice(index + 1) };
}

export function loadDrafts(now = Date.now()): Record<string, Draft> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DRAFTS_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, Draft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { body, updatedAt } = value as { body?: unknown; updatedAt?: unknown };
      if (typeof body !== "string" || body.trim().length === 0) continue;
      if (typeof updatedAt !== "number" || now - updatedAt > MAX_AGE_MS) continue;
      out[key] = { body, updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDrafts(drafts: Readonly<Record<string, Draft>>): void {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota or a blocked store. The in-memory draft still works for this session.
  }
}

/** Reads a scalar preference, tolerating a store that throws. */
export function readSetting(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Same as above: a remembered tab or theme is a convenience, never state the app needs.
  }
}
