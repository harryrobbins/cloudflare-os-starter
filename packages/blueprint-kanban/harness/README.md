# Multi-user harness

A local simulator for the kanban board: two or more side-by-side panes, each running the real built `dist/client.js`, all talking to one fake server that runs the real board rules (`src/core/board.js`) and subscriber hub (`src/core/hub.js`) over an `InMemoryRepository`, in the browser.

There is no dev server and no file watching. Rebuild, then reload.

## Run it

From `packages/blueprint-kanban`:

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
| `latency=300` | Initial one-way latency in ms |
| `downtime=800` | How long the server refuses calls after a restart (default 250 ms) |
| `export=html` | Also add an export-mode pane (`gadgetExportFormatId = "html"`) |

## Controls

- **Latency**: 0 to 1000 ms, applied in order per pane to calls (pane to server) and to events (server to pane).
- **Restart server**: a new core instance over the same repository and a new, empty hub, without disposing callbacks. This simulates a facet restart. Clients notice through the heartbeat (`updatePresence` returns `known: false`) and resubscribe. Calls during the downtime fail.
- **Restart + dispose**: the same, and also calls `[Symbol.dispose]()` on every callback a pane passed to `subscribe`.
- **Kill pane** removes the iframe without `leavePresence`, like a crashed tab. The hub drops the pane on its next failed delivery, and other clients also expire it after 12 s without a heartbeat.
- **Reload** reloads one pane (new client id).
- **Add pane** and **Add export pane**.

## How a pane is wired

`pane.html` carries the platform iframe's CSP (`default-src 'none'; script-src data: 'unsafe-inline'; ... connect-src 'none'`). It asks the parent for:

- `gadget`, a proxy whose method calls go to the fake server with structured-cloned arguments and results;
- `RpcTarget`, a trivial class. Instances passed as arguments go by reference, wrapped in a stub with `dup()` and `onRpcBroken()`. Delivery to a killed pane rejects.

It then runs `dist/client.js` as an inline module, as the platform does. Unlike the platform, the iframe is same-origin, because the parent has to reach into it.

## Scripting it

`window.harness` in the parent page:

| Member | Does |
| --- | --- |
| `getBoard()`, `getHistory(n)`, `getComments(cardId)` | Read the server state |
| `rpc(method, ...args)` | Call any RPC method directly, as a third user such as the chat agent would |
| `apply(request)` | Shorthand for `rpc("applyOperation", request)` |
| `subscribers()` | The hub's current subscribers |
| `restart({dispose})`, `setLatency(ms)` | Same as the controls |
| `addPane({exportFormat})`, `killPane(id)`, `reloadPane(id)`, `panes()`, `paneInfo()` | Manage panes |

Inside each pane, `window.kanbanStore` is the client's store.

## Tests

```bash
node scripts/build.mjs
node --test e2e/harness.test.mjs      # starts and stops serve.mjs itself, headless Chromium
HARNESS_SHOTS=/some/dir node --test e2e/harness.test.mjs   # screenshots (default /tmp/harness-shots)
node e2e/harness-smoke.mjs /some/dir  # screenshots only: seeded board, light and dark, panel, menu
```

The helpers are in `e2e/harness-helpers.mjs`.
