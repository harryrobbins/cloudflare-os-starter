// The route table.
//
// Code-based rather than file-based: the tree is a dozen routes, and generating a route tree would add
// a plugin, a generated file and a watcher to a package whose build has to stay a plain `vite build`.
//
// `basepath` is `APP_BASE`, so every `to` in the app is written without the prefix while the browser
// sees `/gatekeeper/chat/...`. `navigateToAppPath` converts the other way for the paths that arrive
// already prefixed -- a permalink from `permalink()`, a toast's href, the shell's `chat:open`.

import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { APP_BASE, GENERAL_CHANNEL_ID, matchPath } from "./contract.js";
import { AppShell, useLayout } from "./components/AppShell.js";
import { setAppNavigator } from "./lib/navigate.js";
import { toRouterPath } from "./lib/nav.js";
import type { ChatStore } from "./store/store.js";
import { BrowseView } from "./views/BrowseView.js";
import { ChannelScreen } from "./views/ChannelScreen.js";
import { DraftsView } from "./views/DraftsView.js";
import { MentionsView } from "./views/MentionsView.js";
import { PeopleView } from "./views/PeopleView.js";
import { SearchView } from "./views/SearchView.js";
import { SettingsView } from "./views/SettingsView.js";
import { ThreadsView } from "./views/ThreadsView.js";

const LAST_CHANNEL_KEY = "chat.lastChannel";

/** Set once in `main.tsx`; the index route needs the store before any component has mounted. */
let store: ChatStore | null = null;

export function attachStore(next: ChatStore): void {
  store = next;
}

const rootRoute = createRootRoute({ component: AppShell });

/**
 * `/` picks a conversation: the last one this browser had open, else `#general`, else the first channel
 * the rail would show. It waits for the channel list rather than guessing, which is why it is a loader.
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: async () => {
    if (store === null) return;
    for (let attempt = 0; attempt < 50 && store.state.phase === "loading"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const state = store.state;
    const remembered = safeRead(LAST_CHANNEL_KEY);
    const candidates = Object.values(state.channels).filter(
      (channel) => state.memberships[channel.id] !== undefined && !channel.archived,
    );
    const target =
      (remembered !== null && candidates.find((channel) => channel.id === remembered)) ||
      candidates.find((channel) => channel.id === GENERAL_CHANNEL_ID) ||
      candidates.toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))[0];
    if (target === undefined) throw redirect({ to: "/browse" });
    throw redirect({ to: "/c/$channelId", params: { channelId: target.id } });
  },
  component: () => null,
});

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$channelId",
  component: function ChannelRouteComponent(): ReactNode {
    const { channelId } = useParams({ from: "/c/$channelId" });
    remember(channelId);
    return <ChannelScreen channelId={channelId} />;
  },
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$channelId/t/$rootId",
  component: function ThreadRouteComponent(): ReactNode {
    const { channelId, rootId } = useParams({ from: "/c/$channelId/t/$rootId" });
    remember(channelId);
    return <ChannelScreen channelId={channelId} rootId={rootId} />;
  },
});

/** The permalink. `around=` paging, highlight and scroll-into-view all hang off `focusMessageId`. */
const messageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$channelId/m/$messageId",
  component: function MessageRouteComponent(): ReactNode {
    const { channelId, messageId } = useParams({ from: "/c/$channelId/m/$messageId" });
    remember(channelId);
    return <ChannelScreen channelId={channelId} focusMessageId={messageId} />;
  },
});

const threadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/threads",
  component: function ThreadsRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    return (
      <ThreadsView
        onBack={layout.narrow ? layout.openRail : undefined}
        onOpen={(channelId, rootId) =>
          void navigate({ to: "/c/$channelId/t/$rootId", params: { channelId, rootId } })
        }
      />
    );
  },
});

const mentionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mentions",
  component: function MentionsRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    return (
      <MentionsView
        onBack={layout.narrow ? layout.openRail : undefined}
        onJump={(channelId, messageId) =>
          void navigate({ to: "/c/$channelId/m/$messageId", params: { channelId, messageId } })
        }
      />
    );
  },
});

const draftsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drafts",
  component: function DraftsRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    return (
      <DraftsView
        onBack={layout.narrow ? layout.openRail : undefined}
        onOpen={(channelId, rootId) =>
          rootId === null
            ? void navigate({ to: "/c/$channelId", params: { channelId } })
            : void navigate({ to: "/c/$channelId/t/$rootId", params: { channelId, rootId } })
        }
      />
    );
  },
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  component: function SearchRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    const { q } = useSearch({ from: "/search" });
    return (
      <SearchView
        initialQuery={q}
        onBack={layout.narrow ? layout.openRail : undefined}
        onQueryChange={(next) => void navigate({ to: "/search", search: { q: next }, replace: true })}
        onJump={(channelId, messageId) =>
          void navigate({ to: "/c/$channelId/m/$messageId", params: { channelId, messageId } })
        }
        onOpenChannel={(channelId) => void navigate({ to: "/c/$channelId", params: { channelId } })}
      />
    );
  },
});

/** `/dm/:userId` opens the direct message with that person, creating it on first use. */
const dmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$userId",
  loader: async ({ params }) => {
    if (store === null) return;
    for (let attempt = 0; attempt < 50 && store.state.phase === "loading"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const channelId = await store.openDm(params.userId);
    if (channelId === null) throw redirect({ to: "/people" });
    throw redirect({ to: "/c/$channelId", params: { channelId } });
  },
  component: () => null,
});

const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/browse",
  component: function BrowseRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    return (
      <BrowseView
        onBack={layout.narrow ? layout.openRail : undefined}
        onNewChannel={layout.openNewChannel}
        onOpen={(channelId) => void navigate({ to: "/c/$channelId", params: { channelId } })}
      />
    );
  },
});

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/people",
  component: function PeopleRouteComponent(): ReactNode {
    const navigate = useNavigate();
    const layout = useLayout();
    return (
      <PeopleView
        onBack={layout.narrow ? layout.openRail : undefined}
        onOpenDm={(userId) => void navigate({ to: "/dm/$userId", params: { userId } })}
      />
    );
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: function SettingsRouteComponent(): ReactNode {
    const layout = useLayout();
    return <SettingsView onBack={layout.narrow ? layout.openRail : undefined} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  channelRoute,
  threadRoute,
  messageRoute,
  threadsRoute,
  mentionsRoute,
  draftsRoute,
  searchRoute,
  dmRoute,
  browseRoute,
  peopleRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: APP_BASE,
  defaultPreload: false,
  // A missing conversation is handled inside the view, which can offer Join; the router's own 404 would
  // throw away the shell.
  defaultNotFoundComponent: () => null,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * Navigates to a path that already carries the mount prefix.
 *
 * The three sources are `permalink()`, a toast's href and the shell's `chat:open`. Each is matched back
 * to a typed route with `matchPath`, the contract's own matcher, rather than handed to the router as an
 * opaque string -- so a path this app cannot serve lands on the index instead of a blank screen.
 */
function navigateToRoute(absolutePath: string): void {
  const path = toRouterPath(absolutePath.split("?")[0] ?? absolutePath);

  const message = matchPath("/c/:channelId/m/:messageId", path);
  if (message !== null) {
    void router.navigate({
      to: "/c/$channelId/m/$messageId",
      params: { channelId: message.channelId!, messageId: message.messageId! },
    });
    return;
  }
  const thread = matchPath("/c/:channelId/t/:rootId", path);
  if (thread !== null) {
    void router.navigate({
      to: "/c/$channelId/t/$rootId",
      params: { channelId: thread.channelId!, rootId: thread.rootId! },
    });
    return;
  }
  const channel = matchPath("/c/:channelId", path);
  if (channel !== null) {
    void router.navigate({ to: "/c/$channelId", params: { channelId: channel.channelId! } });
    return;
  }
  const dm = matchPath("/dm/:userId", path);
  if (dm !== null) {
    void router.navigate({ to: "/dm/$userId", params: { userId: dm.userId! } });
    return;
  }
  void router.navigate({ to: "/" });
}

function remember(channelId: string): void {
  try {
    window.localStorage.setItem(LAST_CHANNEL_KEY, channelId);
  } catch {
    /* Blocked storage: the index route falls back to #general. */
  }
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

setAppNavigator(navigateToRoute);

export { navigateToRoute as navigateToAppPath };
