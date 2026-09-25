# @records/sync-client

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Browser sync client for Records datastores: optimistic mutations, push/pull, and rebase over
server state (canonical Postgres datastore plan §6). No runtime dependencies. It imports only types
from `@records/contracts`, so zod stays out of gadget bundles (about 7.5 kB gzipped).

```ts
import { SyncClient, httpTransport, pokeSource, guardUnload } from "@records/sync-client";

const client = new SyncClient({
  principal: viewer,                                      // PrincipalRef of the signed-in viewer
  transport: httpTransport(`${base}/v1/datastores/${id}`, fetch, () => ({ authorization: `Bearer ${token()}` })),
  onPoke: pokeSource(new EventSource(pokeUrl), { datastoreId: id }),
});
await client.start();                                     // first pull, poke subscription, safety pull
guardUnload(client);                                      // warn before closing with unsynced changes

client.subscribe(({ changedKeys }) => render(client.scan("issue/")));
const h = client.mutate.projects.createIssue({ projectId, title: "Fix login" });
h.args.id;                                                // client-chosen id; kept after confirmation
await h.result;                                           // { status: "confirmed" | "processed" | "pending" | "rejected" | "conflict", … }
```

## API

- `new SyncClient(options)`: `transport` and `principal` are required. Optional: `mutators`
  (defaults to the Projects mutators), `prepare`, `appliedIn`, `describe`, `clientGroupId`,
  `clientId` (fresh per page load by default; never reuse one from an earlier page load, because
  mutation ids restart at 1), `onPoke`, `pushDelayMs` (20), `safetyPullIntervalMs` (30 000; 0
  turns it off), `approvalCheckIntervalMs` (5 000), `approvalTimeoutMs` (15 min), `retryBaseMs`,
  `retryMaxMs`, `maxBatch` (100), and `timers`, `now`, `randomUUID`, `random` for tests.
- Reads come from the optimistic view: `get(key)`, `scan(prefix)` (key order), `store.values(prefix)`,
  `store.server` (confirmed state only), and `subscribe(listener)`.
- Writes: `mutate.projects.createIssue | editIssue | transitionIssue | addComment(args)`, or
  `mutateByName(name, args)`. Each returns `{ id, args, likelyToFail, result }`.
- Control: `start()`, `close()`, `pull()`, `poke(head)`, `flush()`, `sync()`, `retry()`,
  `checkApprovals()`, `dismissApproval(mutationId)`.
- State: `cookie`, `hasUnsyncedChanges`, `pending()`, `awaitingApproval`, `status()`.
- Events: `on("rejected" | "awaiting" | "approval" | "status", fn)` returns an unsubscribe.
- `httpTransport(baseUrl, fetch?, headers?, { timeoutMs? })`: `POST {base}/sync/push` and
  `POST {base}/sync/pull`. Problem documents become a `SyncTransportError` with `kind` (`network`,
  `server` or `client`), `status`, `code` and `message`.
- `pokeSource(eventSourceOrWebSocket, { datastoreId?, eventType?, pullOnOpen? })` returns the
  `onPoke` hook. It pulls on (re)connect because pokes sent while disconnected are lost.
- `guardUnload(client, target?)` returns a remover.
- Mutators (`src/mutators/projects.ts`) are pure `(tx: WriteTx, args) => void` functions over
  `{ get, has, scan, put, del, context }`. `context` holds `principal`, `timestamp` and, on a
  server, `allocateIssueNumber`. A mutator that predicts failure throws `MutationError` with
  `not_found`, `validation_failed`, `revision_conflict`, `workflow_conflict` or `duplicate`, and
  its writes are discarded.

## Conventions

- Store and patch keys: `project/<id>`, `issue/<id>`, `comment/<id>` hold the contract DTOs, and
  `meta/workflow` holds the `Workflow`. A `clear` op resets server state.
- **Placeholder key.** An issue created locally has `number: 0` and `key: "<PROJECT>-?"` (for
  example `ENG-?`) until the server's version arrives by pull. `isProvisionalIssue(issue)` tests for
  this. Its `id` never changes, so links and follow-up edits made meanwhile stay valid.
- Creates carry a client-chosen `id` (`crypto.randomUUID()`, filled in by `prepareProjectArgs` when
  the caller does not supply one). Edits and transitions carry the `expectedRevision` the user saw.
  After a local edit, that is the predicted revision, which is correct because the server adds 1
  per edit.
- Nothing is persisted. Pending mutations live in memory. `hasUnsyncedChanges` is true while any
  mutation has no push outcome. Those mutations would be lost on unload.

## Event semantics

| Push outcome | View | `result` | Events |
|---|---|---|---|
| `applied` | Guess stays until a pull's `lastMutationIdChanges` covers it, then the server's row replaces it. | `confirmed` | none |
| `skipped` (already processed, for example after a lost response) | As applied. | `processed` | none |
| `pending` | Guess removed at once. | `pending` + `actionId` | `awaiting` (list). Later, `approval` with `applied` (a pull shows it, or `approvals()` said approved and a later pull finished), `rejected`, `expired`, `timeout` or `dismissed`. |
| `rejected` / `conflict` | Guess removed at once, so the server's version shows. | same | `rejected` with `code` and `message`, plus `currentRevision` for a conflict. `source: "push"`. |

- A rejected, expired or timed-out approval also emits `rejected` with `source: "approval"` and
  `code: "approval_rejected" | "approval_expired" | "approval_timeout"`.
- A request-level 400/413 is handled by pushing the batch one mutation at a time. The mutation that
  is refused alone is dropped with `source: "local"`.
- A 401/403 (any other non-retryable 4xx) blocks pushes until the next mutation, `retry()` or
  `flush()`.
- Network errors, 5xx, 408 and 429 retry with exponential backoff and jitter. There is one push in
  flight at a time, and the order is never changed.
- When a mutator throws during a replay (for example, a pull brought someone else's edit), the
  mutation stays queued and is still pushed, because the server decides. Its `likelyToFail` is set
  so the UI can warn, and the view shows the server's version.
- `subscribe` fires once per batch (a local mutation, or a pull with its replay), and only with the
  keys whose visible value changed (structural comparison).
- Pull responses with a cookie older than the current one are ignored. The cookie only moves
  forward.
- `result` never rejects. After `close()`, results that are still outstanding stay unresolved.

## What the server must do

These requirements go beyond the types in `records-contracts/src/sync.ts`:

1. **Push, in order and idempotently.** Handle mutations in array order. Keep one `lastMutationId`
   per `clientId` (scoped to its `clientGroupId`), and update it in the same transaction as the
   command. A mutation with `id <= lastMutationId` returns `skipped` and has no effect. **Accept
   gaps**: any `id > lastMutationId` is valid. The client drops a mutation the server refused at the
   request level, so its id is never processed. A `rejected`, `conflict` or `pending` mutation still
   counts as processed.
2. **Validate each mutation's args inside its command.** A bad argument gives that mutation a
   `rejected` / `validation_failed` outcome. Reserve request-level 400 for a malformed envelope. If
   the server stops partway through a batch (for example, on a time budget), it returns outcomes for
   the prefix it handled only. The client pushes the rest again.
3. **Recommended:** for a replayed id, return the saved outcome (especially `pending` with its
   `actionId`) instead of bare `skipped` when you have it. Otherwise, when a push response is lost
   and a mutation went to approval, the client cannot show it as awaiting.
4. **Honour client-chosen ids** in `createIssue` and `addComment`. An id that is already taken is
   `rejected` with `duplicate`.
5. **`head` in the push response** is the datastore clock after the batch. The client pulls when it
   is newer than its cookie.
6. **Pull, from one snapshot.** Read `cookie` (the head), the patch and `lastMutationIdChanges` in
   one read transaction, so a mutation counted in `lastMutationId` is also in the patch. Build the
   patch from journal rows with `seq > cookie`, coalesced per key (`put` of the current DTO, or
   `del` when the entity is gone or no longer visible to the caller under RLS). Send `clear` and the
   full visible state when the cookie is `null`, older than retention, or newer than the head (for
   example, after a restore).
7. **`lastMutationIdChanges`** must include every client in the group whose `lastMutationId`
   changed since the cookie. `pending` and `rejected` mutations change it without advancing `seq`,
   so a pull with `cookie == head` can still carry changes. Returning every client in the group is
   always correct.
8. **Patch values** use exactly the DTO shapes of the native API (`Project`, `Issue`, `Comment`,
   and `Workflow` under `meta/workflow`), because the client compares values structurally.
9. **Pokes** are `{ datastoreId, head }` after commit, sent best effort over SSE (default event) or
   WebSocket. The client also pulls on a timer and on reconnect.
10. **Approvals.** When an approval is granted, run the command as an ordinary journaled change
    under the original principal, with the same checks (a stale `expectedRevision` still
    conflicts), so the result arrives through a pull. If the host can report decisions, add
    `approvals(actionIds) → { actionId, status: "pending" | "approved" | "rejected" | "expired", message? }[]`
    to the transport. Otherwise, awaiting entries end when a pull shows the change, on timeout, or
    when dismissed.
11. `clientGroupId` and `clientId` are 8-64 URL-safe characters. The client generates 32-character
    hex ids.

## Tests

`__tests__/fake-server.ts` is an in-memory server with the semantics above. Its command rules are
written separately from the client's mutators. The tests cover two clients editing the same issue
(§11.3), seeded property runs of convergence under concurrent writers with injected failures,
approvals, retention pruning and a late joiner (§11.2), pulls from every cookie, dropped pokes,
stale pull responses, lost push responses, approvals, the placeholder key, the HTTP transport,
pokes and the unload guard.

```sh
pnpm -C packages/records-sync-client exec tsc --noEmit
pnpm -C packages/records-sync-client exec vitest run
```
