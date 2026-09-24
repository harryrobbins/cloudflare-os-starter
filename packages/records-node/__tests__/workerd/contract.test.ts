// The contract suite inside workerd, through the Worker's fetch handler (SELF), against the same
// database the Node server is serving in the parent process (see ../workerd.test.ts).

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { defineContractSuite } from "../contract/suite.js";
import type { ContractTarget, ContractWorldInfo } from "../contract/target.js";

type Given = ContractWorldInfo & { baseUrl: string; accessAssertion: string; sharedIssueId: string };
const given = JSON.parse((env as unknown as { CONTRACT_TARGET: string }).CONTRACT_TARGET) as Given;

const target: ContractTarget = { ...given, name: "workerd", fetch: (request) => SELF.fetch(request) };

defineContractSuite(() => target);

describe("cross-runtime: one database", () => {
  it("reads and edits an issue the Node server created", async () => {
    const headers = { "cf-access-jwt-assertion": given.accessAssertion, authorization: `Bearer ${given.credential}` };
    const path = `${given.baseUrl}/gatekeeper/records/v1/datastores/${given.datastoreId}/issues/${given.sharedIssueId}`;
    const got = await SELF.fetch(path, { headers });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { title: string }).title).toBe("Created on Node");
    const edited = await SELF.fetch(path, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "if-match": got.headers.get("etag")!, "idempotency-key": `workerd-edit-${given.sharedIssueId}` },
      body: JSON.stringify({ title: "Edited on Workers" }),
    });
    expect(edited.status).toBe(200);
    expect(edited.headers.get("etag")).toBe('"r2"');
  });
});
