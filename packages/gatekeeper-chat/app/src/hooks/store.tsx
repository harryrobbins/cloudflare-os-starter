// Store plumbing for React.
//
// `useSyncExternalStore` with a selector, rather than context holding the state object: the rail, the
// conversation and the composer all read different slices, and re-rendering a 400-row list because a
// typing indicator changed is exactly the jank the quality bar rules out. Selectors must return a
// stable reference for unchanged state -- scalars, or a slice of the immutable snapshot.

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { CallSnapshot } from "../call/engine/types.js";
import type { ChatStore } from "../store/store.js";
import { INITIAL_STATE, type ChatState } from "../store/state.js";

const StoreContext = createContext<ChatStore | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: ChatStore;
  children: ReactNode;
}): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): ChatStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useStore was called outside the provider.");
  return store;
}

export function useChat<T>(selector: (state: ChatState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(INITIAL_STATE),
  );
}

/**
 * Where this frame's call is -- its conversation and phase -- for components that only place the call
 * and must not re-render on every media or quality change in the snapshot.
 */
export function useCallPlace(): Pick<CallSnapshot, "channelId" | "phase"> {
  const channelId = useChat((state) => state.call.channelId);
  const phase = useChat((state) => state.call.phase);
  return useMemo(() => ({ channelId, phase }), [channelId, phase]);
}
