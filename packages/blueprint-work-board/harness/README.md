# Work Board harness

A local stand-in for the Workshop: the real built `dist/client.js` runs in sandboxed frames under
the platform's CSP, talking over real capnweb to the real gadget server (`src/server/api.js` over
in-memory Durable Object storage), whose `RECORDS` binding is `test/fake-records.js`: an in-memory
Records `work` datastore implementing the migration-010 planning contract, plus the connector's
approval path. No dev server and no file watching: rebuild, then reload.

## Run it

```bash
cd packages/blueprint-work-board
node scripts/build.mjs
setsid node harness/serve.mjs > /tmp/wb-harness.log 2>&1 & echo "pgid $!"
cat /tmp/wb-harness.log        # HARNESS_URL http://127.0.0.1:8795/
# open http://127.0.0.1:8795/?seed=300 ... then stop it:
kill -- -<pgid>
```

`serve.mjs` takes `--port` (default 8795) and `--dist <dir>`; it binds 127.0.0.1 and bundles
`harness/parent.js` with esbuild on every request. `node harness/smoke.mjs` builds, starts the
server in its own process group, checks one seeded board and a manual-approval create, and stops.

## URL parameters

| Parameter | Effect |
| --- | --- |
| `panes=2` | Two frames: Ada Lovelace (`ada@example.com`, role `build`) and Grace Hopper (`grace@example.com`, role `use`). Default 1 |
| `seed=300` | Items seeded through the fake with ~70 days of journal history (`harness/seed.js`). `0` = empty datastore; 2,000 is the perf fixture (≈3,200 records, ≈7,400 changes) |
| `approval=manual` | Commands wait for **Approve all** / `harness.approve(id)`. Default `auto` (applied at once) |
| `v1=1` | A datastore without migration 010: only `work_item` with title/description/status, only `work.create`/`work.update` |
| `access=read` | Read-only connection (`command` fails `read_only:`) |
| `latency=300` | Added before and after every facet call (ms) |
| `timestamps=0` | Records and change entries carry no timestamps (the service before its `created_at` change); default on |
| `now=2026-09-26T12:00:00Z` | Fake clock base; the seed's history ends just before it. Default real now |
| `anon=1` | Pane 1 has no signed-in viewer (`gadgetViewer` null; `$createViewerAssertion` fails `forbidden:`) |
| `cspProbe=0` | Byte-identical platform frame document (no CSP violation reporter) |

## Controls

Approval mode, pending count (with journal seq and epoch), **Approve all**, **Reject oldest**
("Approval was denied"), **External edit** (Linus changes a random item's state or priority via
another client), **Bump epoch** (clients get `reset_required` and must re-snapshot), latency,
**Restart facet** (a new server over the same storage; every existing `gadget` stub rejects
"Gadget restarted due to code update." forever, as on the platform after a code edit; only a pane
reload recovers), **Reload pane N**.

## `window.harness`

| Member | Does |
| --- | --- |
| `ready`, `seedMs`, `handshakes`, `generation` | Page ready; seed time; RPC sessions opened; facet generation |
| `fake` | The `FakeRecords` instance: `rows`, `journal`, `actions`, `run(command, input, {actor, revision})`, `approve`/`reject`/`approveAll`, `pendingActions()`, `setApproval`, `setEpoch`, `failNext(method, message, count)`, `calls` |
| `api`, `rpc(method, ...args)` | The gadget server; call any RPC as the in-Workshop agent would (e.g. `rpc("query", "is:blocked")`) |
| `storage` | The server's in-memory storage (`storage.map`: `view:*`, `pref:*`, `settings`) |
| `pending()` | Pending actions as `{id, command, input, actor}` |
| `approveAll()`, `approve(id)`, `reject(id, reason?)`, `rejectOldest()`, `setApproval("auto"\|"manual")` | Approval queue |
| `external()` | Linus's edit; returns `{id, number, patch}` |
| `bumpEpoch()`, `setLatency(ms)`, `dropNextCalls(n)`, `restartFacet()`, `reloadPane(i)`, `paneLoads(i)` | Failure and recovery |
| `violations`, `logs` | CSP violations and forwarded pane console output |

## What is faithful, and what is not

Faithful: the frame document, sandbox flags, CSP and prefix (`gadget`, `gadgetViewer`,
`RpcTarget` as module-scope bindings) copied verbatim from `GadgetUI.tsx`; capnweb structured
cloning; the gadget server code; intent digests checked with the connector's own
`recordsOsIntentDigest`; the connector's rejection strings (`Records refused the command (400|403|404|409|412|428)`,
`Approval was denied`); snapshot bounds and journal cursor semantics of records-service SQL 008.

The fake follows `packages/records-service/sql/010-work-planning.sql`: one command is one commit
(one journal `seq`); the first command in an empty datastore also writes the seven default states
(Triage, Backlog, Todo, In Progress, In Review, Done, Canceled — key `canceled`) in that commit at
ordinals 1–7 after the command's own record at 0; change pages never split a commit; record data
omits NULL columns (`null` in an update clears, `labels: []` is absent); references are bare UUIDs;
every create takes an optional client `id` (unique across work entities, else 409); the SQL's limits,
messages and SQLSTATEs (400/403/404/409/412/428) are reproduced. A failed command changes nothing.

Not faithful: the approval UI is these buttons, not the Workshop; there is no observation
authorisation, rate limit (the platform handles ~45 RPC/s per gadget) or 128 KiB storage value
cap; `timestamps=0` removes record and change times; errors thrown by `run()` keep the
SQL message after the code, while the real connector's session errors carry codes with generic
text; the frame is a same-page srcdoc, so a pane reload is instant.
