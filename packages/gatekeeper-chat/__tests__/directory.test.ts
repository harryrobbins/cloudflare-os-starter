// People: who appears in the directory, and the one rule that decides who may see whom.
//
// Somebody appears the first time any request of theirs reaches the object. Before the shell called
// `POST /api/me/seen`, that meant "the first time they opened chat", which is why colleagues who used
// the platform every day were missing from People. These tests pin both halves: the shell's call is
// enough on its own, and every listing goes through `directoryFilter`.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  AGENT_USER_ID,
  type ChannelResponse,
  type OkResponse,
  type SearchResult,
  type UserListResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { directoryFilter, visibleInDirectory } from "../src/do/users.js";
import type { Ctx } from "../src/do/context.js";
import type { UserRow } from "../src/do/rows.js";
import { client, freshWorkspace, identity } from "./helpers.js";

describe("the directory", () => {
  it("lists a colleague who has only loaded the platform shell", async () => {
    const workspace = freshWorkspace("people-seen");
    const harry = client(workspace, identity("harry", "Harry"));
    const colleague = client(workspace, identity("colleague", "Colleague"));

    await harry.get(apiPath("me"));
    expect((await harry.get<UserListResponse>(apiPath("listUsers"))).users.map((user) => user.id)).not.toContain(
      "colleague",
    );

    // What the shell sends once per session: nothing but the verified identity.
    expect(await colleague.send<OkResponse>("POST", apiPath("markSeen"))).toEqual({ ok: true });

    const listed = await harry.get<UserListResponse>(apiPath("listUsers"));
    expect(listed.users.find((user) => user.id === "colleague")).toMatchObject({
      name: "Colleague",
      kind: "person",
    });
    expect((await harry.get<{ user: { id: string } }>(apiPath("getUser", { userId: "colleague" }))).user.id).toBe(
      "colleague",
    );
    const found = await harry.get<SearchResult>(`${apiPath("search")}?q=Colleague`);
    expect(found.users.map((user) => user.id)).toContain("colleague");

    // A real row, so a DM can be started now and waits for them.
    const dm = await harry.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "dm",
      memberIds: ["colleague"],
    });
    expect(dm.channel.memberIds).toEqual(expect.arrayContaining(["harry", "colleague"]));
  });

  it("lists the Agent, so it can be messaged", async () => {
    const workspace = freshWorkspace("people-agent");
    const harry = client(workspace, identity("harry"));
    const users = (await harry.get<UserListResponse>(apiPath("listUsers"))).users;
    expect(users.find((user) => user.id === AGENT_USER_ID)).toMatchObject({ kind: "agent", name: "Agent" });
  });

  it("is one rule: a person the filter hides is absent from every listing and cannot be messaged", async () => {
    const workspace = freshWorkspace("people-rule");
    const harry = client(workspace, identity("harry", "Harry"));
    await client(workspace, identity("guest", "Guest Person")).get(apiPath("me"));

    // Stands in for a future restricted kind: a row the rule does not admit.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`UPDATE users SET kind = 'restricted' WHERE id = 'guest'`);
    });

    const users = (await harry.get<UserListResponse>(apiPath("listUsers"))).users.map((user) => user.id);
    expect(users).not.toContain("guest");
    expect(await harry.status("GET", apiPath("getUser", { userId: "guest" }))).toBe(404);
    const found = await harry.get<SearchResult>(`${apiPath("search")}?q=Guest`);
    expect(found.users.map((user) => user.id)).not.toContain("guest");
    expect(
      await harry.error("POST", apiPath("createChannel"), { kind: "dm", memberIds: ["guest"] }),
    ).toEqual({ status: 404, code: "not_found" });

    await runInDurableObject(workspace, (_instance, state) => {
      const ctx = { sql: state.storage.sql } as unknown as Ctx;
      const viewer = state.storage.sql.exec<UserRow>(`SELECT * FROM users WHERE id = 'harry'`).toArray()[0]!;
      expect(visibleInDirectory(ctx, viewer, "harry")).toBe(true);
      expect(visibleInDirectory(ctx, viewer, AGENT_USER_ID)).toBe(true);
      expect(visibleInDirectory(ctx, viewer, "guest")).toBe(false);
      expect(visibleInDirectory(ctx, viewer, "nobody")).toBe(false);
    });
  });

  it("admits every person and the Agent today", () => {
    expect(directoryFilter({ id: "harry", kind: "person" }).sql).toBe("u.kind IN ('person', 'agent')");
  });
});

describe("naming people a client has never seen", () => {
  it("looks several people up by id in one request, through the same rule", async () => {
    const workspace = freshWorkspace("people-ids");
    const harry = client(workspace, identity("harry", "Harry"));
    await client(workspace, identity("nia", "Nia")).get(apiPath("me"));
    await client(workspace, identity("guest", "Guest")).get(apiPath("me"));
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`UPDATE users SET kind = 'restricted' WHERE id = 'guest'`);
    });

    const found = await harry.get<UserListResponse>(`${apiPath("listUsers")}?ids=nia,guest,nobody,${AGENT_USER_ID}`);
    expect(found.users.map((user) => user.id)).toEqual([AGENT_USER_ID, "nia"]);
    expect(found.cursor).toBeNull();
    expect(await harry.status("GET", `${apiPath("listUsers")}?ids=not%20an%20id`)).toBe(400);
    expect(await harry.status("GET", `${apiPath("listUsers")}?ids=${Array.from({ length: 101 }, (_, i) => `u${i}`).join(",")}`)).toBe(400);
  });
});
