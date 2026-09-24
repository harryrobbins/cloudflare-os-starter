// Omni-search sync: what the chat Durable Object pushes to the search Worker, and when.
//
// Runs in the `omni-search` project, where SEARCH is bound to a mock SearchService
// (__tests__/aux/search-service.js). The object's alarm flushes on its own; the tests also flush
// through the `runSearchOutbox()` seam so an assertion never races the alarm. Both paths are
// serialised inside the object, so a batch is never pushed twice.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { IngestBatch, IngestDocument } from "../../src/search-client.js";
import {
  GENERAL_CHANNEL_ID,
  IDENTITY_HEADER,
  type ChannelResponse,
  type SearchSyncStatus,
  type SendMessageResponse,
  type UploadResponse,
} from "../../src/shared/protocol.js";
import { apiPath, permalink } from "../../src/shared/routes.js";
import { ADMIN_IDENTITY, client, freshWorkspace, identity, ORIGIN, type Client, type Workspace } from "../helpers.js";

const control = env.SEARCH_CONTROL;

function unique(label: string): string {
  return `${label}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function post(who: Client, channelId: string, body: string, extra: Record<string, unknown> = {}) {
  return who.send<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), {
    body,
    clientId: `c-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  });
}

async function flush(workspace: Workspace): Promise<number | null> {
  return workspace.runSearchOutbox();
}

/** Every accepted batch mentioning `marker`, oldest first. */
async function batches(marker: string): Promise<IngestBatch[]> {
  return (await control.ingests(marker)).map((entry) => {
    expect(entry.source).toBe("chat");
    return entry.batch;
  });
}

/** The last pushed version of one document. */
async function lastUpsert(documentId: string): Promise<IngestDocument | undefined> {
  const all = (await batches(documentId)).flatMap((batch) => batch.upserts ?? []);
  return all.filter((doc) => doc.id === documentId).at(-1);
}

async function outboxRows(workspace: Workspace): Promise<{ kind: string; ref: string }[]> {
  return runInDurableObject(workspace, (_instance, state) =>
    state.storage.sql.exec<{ kind: string; ref: string }>(`SELECT kind, ref FROM search_outbox`).toArray(),
  );
}

async function allowRetryNow(workspace: Workspace): Promise<void> {
  await runInDurableObject(workspace, (_instance, state) => {
    state.storage.sql.exec(`UPDATE search_sync SET next_attempt_at = NULL WHERE id = 1`);
  });
}

async function setup(label: string) {
  const workspace = freshWorkspace(label);
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
  return { workspace, alice, bob };
}

async function channel(who: Client, kind: "public" | "private", name: string, memberIds?: string[]) {
  const created = await who.send<ChannelResponse>("POST", apiPath("createChannel"), {
    kind,
    name,
    ...(memberIds === undefined ? {} : { memberIds }),
  });
  return created.channel.id;
}

describe("messages", () => {
  it("pushes a new message as one document in its channel's scope", async () => {
    const { workspace, alice } = await setup("sync-create");
    const name = unique("design");
    const channelId = await channel(alice, "public", name);
    const sent = await post(alice, channelId, "the widget roadmap");
    await flush(workspace);

    const doc = await lastUpsert(`chat:${sent.message.id}`);
    expect(doc).toEqual({
      id: `chat:${sent.message.id}`,
      kind: "message",
      title: `#${name} · Alice`,
      url: permalink(channelId, sent.message.id),
      scope: `chat:${channelId}`,
      vis: "all",
      body: "the widget roadmap",
      channel: channelId,
      authorId: "alice",
      author: "Alice",
      createdAt: sent.message.createdAt,
      updatedAt: sent.message.createdAt,
    });
    // A public channel is declared, but carries no principals.
    const all = await batches(`chat:${channelId}`);
    const scopes = all.flatMap((batch) => batch.scopes ?? []).filter((s) => s.scope === `chat:${channelId}`);
    expect(scopes.at(-1)).toEqual({ scope: `chat:${channelId}`, label: `#${name}`, vis: "all" });
    expect(all.flatMap((batch) => batch.principals ?? []).some((p) => p.scope === `chat:${channelId}`)).toBe(false);
    expect(await outboxRows(workspace)).toEqual([]);
  });

  it("pushes a thread reply, an edit and a delete", async () => {
    const { workspace, alice, bob } = await setup("sync-edit");
    const channelId = await channel(alice, "public", unique("edits"));
    const root = await post(alice, channelId, "original text");
    const reply = await post(bob, channelId, "a reply in the thread", { rootId: root.message.id });
    await flush(workspace);
    expect((await lastUpsert(`chat:${reply.message.id}`))?.body).toBe("a reply in the thread");
    expect((await lastUpsert(`chat:${reply.message.id}`))?.author).toBe("Bob");

    const edited = await alice.send<{ message: { editedAt: number } }>(
      "PATCH",
      apiPath("editMessage", { messageId: root.message.id }),
      { body: "edited text" },
    );
    await flush(workspace);
    const doc = await lastUpsert(`chat:${root.message.id}`);
    expect(doc?.body).toBe("edited text");
    expect(doc?.updatedAt).toBe(edited.message.editedAt);
    expect(doc?.createdAt).toBe(root.message.createdAt);

    // The reply goes outright; the root becomes a tombstone for its remaining replies. Both leave the
    // index.
    await bob.send("DELETE", apiPath("deleteMessage", { messageId: reply.message.id }));
    await post(bob, channelId, "second reply keeps the root a tombstone", { rootId: root.message.id });
    await alice.send("DELETE", apiPath("deleteMessage", { messageId: root.message.id }));
    await flush(workspace);
    const allDeletes = [
      ...(await batches(`chat:${reply.message.id}`)).flatMap((batch) => batch.deletes ?? []),
      ...(await batches(`chat:${root.message.id}`)).flatMap((batch) => batch.deletes ?? []),
    ];
    expect(allDeletes).toContain(`chat:${reply.message.id}`);
    expect(allDeletes).toContain(`chat:${root.message.id}`);
  });

  it("indexes the Agent's and system messages like any other", async () => {
    const { workspace, alice } = await setup("sync-system");
    const name = unique("renamed");
    const channelId = await channel(alice, "public", unique("before"));
    await alice.send("PATCH", apiPath("updateChannel", { channelId }), { name });
    await flush(workspace);
    const notices = (await batches(channelId))
      .flatMap((batch) => batch.upserts ?? [])
      .filter((doc) => doc.authorId === "agent");
    expect(notices.at(-1)).toMatchObject({ author: "Agent", title: `#${name} · Agent` });
    expect(notices.at(-1)?.body).toContain(`to #${name}`);
  });

  it("includes attachment file names in the body", async () => {
    const { workspace, alice } = await setup("sync-files");
    const channelId = await channel(alice, "public", unique("files"));
    const form = new FormData();
    form.set("channelId", channelId);
    form.set("file", new File([new TextEncoder().encode("hello")], "quarterly-plan.txt"));
    const uploaded = await workspace.fetch(
      new Request(`${ORIGIN}${apiPath("createUpload")}`, {
        method: "POST",
        headers: { [IDENTITY_HEADER]: JSON.stringify(alice.identity) },
        body: form,
      }),
    );
    expect(uploaded.status).toBe(200);
    const { attachment } = (await uploaded.json()) as UploadResponse;
    const sent = await post(alice, channelId, "see attached", { attachmentIds: [attachment.id] });
    await flush(workspace);
    expect((await lastUpsert(`chat:${sent.message.id}`))?.body).toBe("see attached\nquarterly-plan.txt");
  });
});

describe("channels and principals", () => {
  it("scopes a private channel's messages and replaces its principals as membership changes", async () => {
    const { workspace, alice, bob } = await setup("sync-private");
    const name = unique("secret");
    const channelId = await channel(alice, "private", name, ["bob"]);
    const sent = await post(alice, channelId, "private words");
    await flush(workspace);

    expect((await lastUpsert(`chat:${sent.message.id}`))?.vis).toBe("scoped");
    const scope = `chat:${channelId}`;
    let all = await batches(scope);
    expect(all.flatMap((batch) => batch.scopes ?? []).filter((s) => s.scope === scope).at(-1)).toEqual({
      scope,
      label: `#${name}`,
      vis: "scoped",
    });
    expect(all.flatMap((batch) => batch.principals ?? []).filter((p) => p.scope === scope).at(-1)).toEqual({
      scope,
      replace: ["alice", "bob"],
    });

    await bob.send("POST", apiPath("leaveChannel", { channelId }));
    await flush(workspace);
    all = await batches(scope);
    expect(all.flatMap((batch) => batch.principals ?? []).filter((p) => p.scope === scope).at(-1)).toEqual({
      scope,
      replace: ["alice"],
    });
  });

  it("labels a direct message by its participants", async () => {
    const { workspace, alice, bob } = await setup("sync-dm");
    // Bob has to exist in the directory before Alice can message him.
    await bob.get(apiPath("me"));
    const dm = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), { kind: "dm", memberIds: ["bob"] });
    const sent = await post(alice, dm.channel.id, "just between us");
    await flush(workspace);
    const doc = await lastUpsert(`chat:${sent.message.id}`);
    expect(doc).toMatchObject({ title: "Alice, Bob · Alice", vis: "scoped", scope: `chat:${dm.channel.id}` });
    const principals = (await batches(`chat:${dm.channel.id}`)).flatMap((batch) => batch.principals ?? []);
    expect(principals.at(-1)).toEqual({ scope: `chat:${dm.channel.id}`, replace: ["alice", "bob"] });
  });

  it("re-labels the scope and re-titles its messages on a rename", async () => {
    const { workspace, alice } = await setup("sync-rename");
    const channelId = await channel(alice, "public", unique("old"));
    const sent = await post(alice, channelId, "a message that outlives the name");
    await flush(workspace);
    const renamed = unique("new");
    await alice.send("PATCH", apiPath("updateChannel", { channelId }), { name: renamed, topic: "fresh topic" });
    await flush(workspace);
    expect((await lastUpsert(`chat:${sent.message.id}`))?.title).toBe(`#${renamed} · Alice`);
    const scopes = (await batches(`chat:${channelId}`)).flatMap((batch) => batch.scopes ?? []);
    expect(scopes.filter((s) => s.scope === `chat:${channelId}`).at(-1)?.label).toBe(`#${renamed}`);
  });

  it("drops a deleted channel's scope", async () => {
    const { workspace, alice } = await setup("sync-drop");
    const channelId = await channel(alice, "private", unique("doomed"));
    await post(alice, channelId, "soon gone");
    await flush(workspace);
    // Chat has no delete route yet; the outbox mapping is what this proves: a channel reference whose
    // row is gone becomes a dropped scope.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM messages WHERE channel_id = ?`, channelId);
      state.storage.sql.exec(`DELETE FROM memberships WHERE channel_id = ?`, channelId);
      state.storage.sql.exec(`DELETE FROM channels WHERE id = ?`, channelId);
      state.storage.sql.exec(
        `INSERT INTO search_outbox (kind, ref, queued_at) VALUES ('channel', ?, ?)`,
        channelId,
        Date.now(),
      );
    });
    await flush(workspace);
    const dropped = (await batches(`chat:${channelId}`)).flatMap((batch) => batch.dropScopes ?? []);
    expect(dropped).toEqual([`chat:${channelId}`]);
  });
});

describe("the outbox", () => {
  it("keeps work through a failing search, backs off, and retries the same rows", async () => {
    const { workspace, alice } = await setup("sync-retry");
    const marker = unique("outage");
    const channelId = await channel(alice, "public", marker);
    // Let the channel's own declaration through, then fail everything else that mentions it.
    await flush(workspace);
    await control.failIngest(marker, 1000);
    const sent = await post(alice, channelId, "written while search is down");
    expect(sent.message.body).toBe("written while search is down");

    const next = await flush(workspace);
    expect(await control.failedAttempts(marker)).toBeGreaterThanOrEqual(1);
    expect(next).toBeGreaterThan(Date.now());
    expect(await outboxRows(workspace)).toContainEqual({ kind: "message", ref: sent.message.id });
    const failed = await workspace.searchStatus();
    expect(failed.attempts).toBeGreaterThanOrEqual(1);
    expect(failed.lastError).toContain("unavailable");
    // Inside the backoff window nothing is attempted.
    const before = await control.failedAttempts(marker);
    await flush(workspace);
    expect(await control.failedAttempts(marker)).toBe(before);

    await control.healIngest(marker);
    await allowRetryNow(workspace);
    await flush(workspace);
    expect((await lastUpsert(`chat:${sent.message.id}`))?.body).toBe("written while search is down");
    expect(await outboxRows(workspace)).toEqual([]);
    const healed = await workspace.searchStatus();
    expect(healed).toMatchObject({ attempts: 0, nextAttemptAt: null });
  });

  it("drops a batch search refuses as invalid input instead of retrying it forever", async () => {
    const { workspace, alice } = await setup("sync-poison");
    const marker = unique("poison");
    const channelId = await channel(alice, "public", marker);
    await flush(workspace);
    await control.failIngest(marker, 1, 0, "search: invalid input: title too long");
    await post(alice, channelId, "refused once");
    await flush(workspace);
    const status = await workspace.searchStatus();
    expect(status.dropped).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toContain("invalid input");
    expect(await outboxRows(workspace)).toEqual([]);
  });
});

describe("backfill", () => {
  it("starts on the first request with SEARCH bound", async () => {
    const workspace = freshWorkspace("sync-first-run");
    const alice = client(workspace, identity("alice", "Alice"));
    await alice.get(apiPath("me"));
    await flush(workspace);
    const status = await workspace.searchStatus();
    expect(status.enabled).toBe(true);
    expect(status.backfill.phase).toBe("done");
    expect(status.backfill.startedAt).not.toBeNull();
    expect(status.backfill.queued).toBeGreaterThanOrEqual(1);
  });

  it("pages through a corpus, survives a failure mid-way, and resumes from its cursor", async () => {
    const { workspace, alice } = await setup("sync-backfill");
    const admin = client(workspace, ADMIN_IDENTITY);
    const channelId = await channel(alice, "public", unique("bulk"));
    // Let the first-run backfill finish before the corpus appears, so every message below is pushed
    // by the admin's reindex alone.
    await flush(workspace);
    expect((await workspace.searchStatus()).backfill.phase).toBe("done");

    const total = 450;
    const ids = Array.from({ length: total }, (_, i) => `m_bulk_${String(i).padStart(4, "0")}`);
    await runInDurableObject(workspace, (_instance, state) => {
      ids.forEach((id, i) => {
        state.storage.sql.exec(
          `INSERT INTO messages (id, channel_id, seq, author_id, body, kind, created_at)
           VALUES (?, ?, ?, 'alice', ?, 'user', ?)`,
          id,
          channelId,
          1000 + i,
          `bulk message number ${i}`,
          Date.now(),
        );
      });
    });

    // Not an admin: refused, and nothing restarts.
    expect(await alice.error("POST", apiPath("searchReindex"))).toMatchObject({ status: 403, code: "forbidden" });
    expect(await alice.error("GET", apiPath("searchIndexStatus"))).toMatchObject({ status: 403 });

    // The channels batch and the first page of messages go through; the next batch fails.
    await control.failIngest(channelId, 1, 2);
    const restarted = await admin.send<SearchSyncStatus>("POST", apiPath("searchReindex"));
    expect(restarted.backfill.phase).toBe("channels");
    await flush(workspace);

    const midway = await admin.get<SearchSyncStatus>(apiPath("searchIndexStatus"));
    expect(midway.attempts).toBe(1);
    expect(midway.backfill.phase).toBe("messages");
    expect(Number(midway.backfill.cursor)).toBeGreaterThan(0);
    expect(midway.outbox.messages).toBeGreaterThan(0);

    // An eviction here loses nothing: the cursor and the outbox are both rows in SQLite.
    await allowRetryNow(workspace);
    for (let i = 0; i < 10 && (await workspace.searchStatus()).backfill.phase !== "done"; i++) {
      await flush(workspace);
    }
    await flush(workspace);
    const done = await admin.get<SearchSyncStatus>(apiPath("searchIndexStatus"));
    expect(done.backfill.phase).toBe("done");
    expect(done.backfill.finishedAt).not.toBeNull();
    expect(done.outbox).toMatchObject({ messages: 0, channels: 0 });

    const pushed = (await batches(channelId))
      .flatMap((batch) => batch.upserts ?? [])
      .map((doc) => doc.id)
      .filter((id) => id.startsWith("chat:m_bulk_"));
    // Every message exactly once: the failed batch was retried, never duplicated.
    expect(pushed).toHaveLength(total);
    expect(new Set(pushed).size).toBe(total);
    for (const batch of await batches(channelId)) {
      expect((batch.upserts?.length ?? 0) + (batch.deletes?.length ?? 0)).toBeLessThanOrEqual(100);
    }
  });
});
