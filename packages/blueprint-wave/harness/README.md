# Multi-user harness

A local simulator for the whiteboard: two or more side-by-side panes, each running the real built `dist/client.js`, all talking to one fake server (`harness/fake-server.js`) that runs the real whiteboard rules (`src/core/whiteboard.js`) and subscriber hub (`src/core/hub.js`) over an `InMemoryRepository`, in the browser.

There is no dev server and no file watching. Rebuild, then reload.

## Run it

From `packages/blueprint-whiteboard`:

```bash
eval "$(fnm env)" && fnm use v24.21.0
node scripts/build.mjs
setsid node harness/serve.mjs > /tmp/harness.log 2>&1 & echo "pgid $!"
cat /tmp/harness.log            # HARNESS_URL http://127.0.0.1:8790/harness/
# ... use it ...
kill -- -<pgid>                 # stop the server when done
```

`serve.mjs` takes `--port` (default 8790, and it tries the next 20 ports if that one is taken). It serves `harness/`, `dist/` and `src/` only.

After changing client code, run `node scripts/build.mjs` again and press **Reload** on a pane (or reload the page, which also resets the board).

## URL parameters

| Parameter | Effect |
| --- | --- |
| `panes=3` | Number of board panes (1 to 4, default 2) |
| `names=Alice,Bob` | Account display names of the panes, in order (default `User A`, `User B`, ...). Each pane gets it as `gadgetViewer.displayName`; nobody is asked for a name |
| `latency=300` | Initial one-way latency in ms |
| `downtime=800` | How long the server refuses calls after a restart (default 250 ms) |
| `export=html` | Also add an export-mode pane (`gadgetExportFormatId = "html"`) |
| `seed=500` | Before the panes load, create that many objects (stickies, shapes and some connectors in a grid) through the real core, for performance checks |

## Controls

- **Latency**: 0 to 1000 ms, applied in order per pane to calls (pane to server) and to events (server to pane).
- **Restart server**: a new core instance over the same repository and a new, empty hub, without disposing callbacks. This simulates a facet restart. Clients notice through the heartbeat (`updatePresence` returns `known: false`) and resubscribe. Calls during the downtime fail.
- **Restart + dispose**: the same, and also calls `[Symbol.dispose]()` on every callback a pane passed to `subscribe`.
- **Restart (stale stub)**: the same restart, and every `gadget` stub handed out so far rejects every call forever. This is what the real platform does to the iframe after a code edit. The client gives up after 3 failed subscribes (or 8 s non-live), reloads its own frame (carrying the viewer's colour, participant id and unsaved text, and the name as a fallback for hosts without `gadgetViewer`, in `window.name`) and comes back under the same account name; the reloaded pane gets a fresh stub.
- **Kill pane** removes the iframe without `leavePresence`, like a crashed tab. The hub drops the pane on its next failed delivery, and other clients also expire it after 12 s without a heartbeat.
- **Reload** reloads one pane (new client id).
- **Add pane** and **Add export pane**.

## How a pane is wired

`pane.html` carries the platform iframe's CSP (`default-src 'none'; script-src data: 'unsafe-inline'; ... form-action 'none'; connect-src 'none'`), and the iframe has `sandbox="allow-scripts allow-same-origin"`: no `allow-forms`, so native form submission is blocked as on the platform. Unlike the platform it is same-origin, because the parent has to reach in. The pane asks the parent for:

- `gadget`, a proxy whose method calls go to the fake server with structured-cloned arguments and results;
- `gadgetViewer`, a frozen `{id, displayName, role}` for the pane's account (`user-a`, the `names=` entry or `User A`, `build`), like the platform's signed-in viewer. The client attributes every change (blips, decisions, reviews, participants, presence) to `displayName`; the me button only changes the colour;
- `RpcTarget`, a trivial class from the pane's realm. Instances passed as arguments go by reference, wrapped in a stub with `dup()` and `onRpcBroken()`. Delivery to a killed pane rejects.

It then runs `dist/client.js` as an inline module with a prefix that declares `gadget`, `gadgetViewer`, `RpcTarget` (and the platform's other prefix names `RpcStub`, `newMessagePortRpcSession`, `blockedOpen`) as module-scope bindings, like the platform's `INJECTED_CODE_PREFIX`. They are not on `window`, so a client that reads `globalThis.gadget` fails here too, and a bundle that declares one of those names at top level fails with a SyntaxError. In export mode `gadgetExportFormatId` is a real global, as in the platform's export page.

## Scripting it

`window.harness` in the parent page:

| Member | Does |
| --- | --- |
| `getBoard()`, `getHistory(n)` | Read the server state |
| `rpc(method, ...args)` | Call any RPC method directly, as a third user such as the chat agent would |
| `apply(request)` | Shorthand for `rpc("applyOperation", request)` |
| `subscribers()` | The hub's current subscribers |
| `restart({dispose, staleStub})`, `setLatency(ms)` | Same as the controls |
| `paneLoads(id)`, `staleRejections` | How many times a pane has loaded (asked for a stub); calls rejected on stale stubs |
| `addPane({exportFormat})`, `killPane(id)`, `reloadPane(id)`, `panes()`, `paneInfo()` | Manage panes |
| `presenceLog(paneId?)`, `clearPresenceLog()` | Every `updatePresence` call so far as `{pane, at, fields}` (last 5,000), to check presence throttling |
| `seed(n)` | Same as `?seed=n`, at any time; resolves with the created ids |
| `ready` | `true` once the (optional) seed is done and the panes are added |

Inside each pane, `window.whiteboardStore` is the client's store and `window.whiteboardCanvas` its canvas controller (`src/client/ui/ui-contract.js`); the canvas also keeps render counters in `window.__wbRenderStats`.

## Tests

```bash
node scripts/build.mjs
node --test e2e/harness.test.mjs      # starts and stops serve.mjs itself, headless Chromium
HARNESS_SHOTS=/some/dir node --test e2e/harness.test.mjs   # screenshots (default /tmp/harness-shots)
```

The helpers and the shared selectors (`SEL`) are in `e2e/harness-helpers.mjs`.
