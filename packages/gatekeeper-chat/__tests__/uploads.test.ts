// Uploads: the streaming byte cap, magic-number sniffing, the atomic attach, the authenticated
// download and the sweep that removes whatever was never attached.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  GENERAL_CHANNEL_ID,
  IDENTITY_HEADER,
  type ChannelResponse,
  type ChatIdentity,
  type SendMessageResponse,
  type UploadResponse,
} from "../src/shared/protocol.js";
import { apiPath, filePath } from "../src/shared/routes.js";
import { client, freshWorkspace, identity, ORIGIN, type Workspace } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 9, 9]);
const TEXT = new TextEncoder().encode("plain words, not an image");
/** The test environment sets MAX_UPLOAD_BYTES to 4 MiB. */
const CAP = 4 * 1024 * 1024;

async function upload(
  workspace: Workspace,
  who: ChatIdentity,
  channelId: string,
  bytes: Uint8Array,
  name: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const form = new FormData();
  form.set("channelId", channelId);
  // `File` takes a BlobPart list; the workers types do not name that union, and a typed
  // array is one.
  form.set("file", new File([bytes], name));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return workspace.fetch(
    new Request(`${ORIGIN}${apiPath("createUpload")}`, {
      method: "POST",
      headers: { [IDENTITY_HEADER]: JSON.stringify(who) },
      body: form,
    }),
  );
}

function setup(label: string) {
  const workspace = freshWorkspace(label);
  const aliceId = identity("alice", "Alice");
  const bobId = identity("bob", "Bob");
  return { workspace, aliceId, bobId, alice: client(workspace, aliceId), bob: client(workspace, bobId) };
}

describe("uploading", () => {
  it("sniffs an image and keeps clamped client dimensions", async () => {
    const { workspace, aliceId } = setup("sniff-image");
    const response = await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png", {
      width: "800",
      height: "99999999",
    });
    expect(response.status).toBe(200);
    const { attachment } = (await response.json()) as UploadResponse;
    expect(attachment).toMatchObject({ mime: "image/png", name: "shot.png", messageId: null, width: 800 });
    // Clamped, not trusted: nothing decoded the image.
    expect(attachment.height).toBe(20_000);
  });

  it("recognises gif and refuses to call anything else an image", async () => {
    const { workspace, aliceId } = setup("sniff-other");
    const gif = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, GIF, "loop.gif")
    ).json()) as UploadResponse;
    expect(gif.attachment.mime).toBe("image/gif");

    // An .svg with an image extension and an image content-type is still not an image.
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    const sneaky = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, svg, "picture.png")
    ).json()) as UploadResponse;
    expect(sneaky.attachment.mime).toBe("application/octet-stream");
  });

  it("strips a directory out of the file name", async () => {
    const { workspace, aliceId } = setup("filename");
    const result = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, TEXT, "../../etc/passwd")
    ).json()) as UploadResponse;
    expect(result.attachment.name).toBe("passwd");
  });

  it("stops reading at the byte cap", async () => {
    const { workspace, aliceId } = setup("cap");
    const response = await upload(
      workspace,
      aliceId,
      GENERAL_CHANNEL_ID,
      new Uint8Array(CAP + 1024),
      "big.bin",
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("refuses an upload into a channel the caller cannot see", async () => {
    const { workspace, alice, bobId } = setup("upload-private");
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "hidden",
    });
    const response = await upload(workspace, bobId, created.channel.id, PNG, "shot.png");
    expect(response.status).toBe(404);
  });
});

describe("attaching", () => {
  it("commits the attachment with the message and serves it back", async () => {
    const { workspace, alice, aliceId, bob } = setup("attach");
    const { attachment } = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png")
    ).json()) as UploadResponse;

    const sent = await alice.send<SendMessageResponse>(
      "POST",
      apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }),
      { body: "here it is", clientId: "c1", attachmentIds: [attachment.id] },
    );
    expect(sent.message.attachments).toHaveLength(1);
    expect(sent.message.attachments[0]).toMatchObject({ id: attachment.id, messageId: sent.message.id });

    const file = await bob.request("GET", filePath(attachment.id));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    // A sniffed image may render inline; nothing else may.
    expect(file.headers.get("content-disposition")).toBe('inline; filename="shot.png"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it("serves anything that is not a verified image as a download", async () => {
    const { workspace, alice, aliceId } = setup("attach-file");
    const { attachment } = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, TEXT, "notes.txt")
    ).json()) as UploadResponse;
    await alice.send("POST", apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }), {
      body: "",
      clientId: "c1",
      attachmentIds: [attachment.id],
    });
    const file = await alice.request("GET", filePath(attachment.id));
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
  });

  it("refuses to attach somebody else's pending upload", async () => {
    const { workspace, aliceId, bob } = setup("attach-theft");
    const { attachment } = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png")
    ).json()) as UploadResponse;
    expect(
      await bob.error("POST", apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }), {
        body: "mine now",
        clientId: "c1",
        attachmentIds: [attachment.id],
      }),
    ).toMatchObject({ status: 403 });
  });

  it("refuses to attach the same upload twice", async () => {
    const { workspace, alice, aliceId } = setup("attach-twice");
    const { attachment } = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png")
    ).json()) as UploadResponse;
    const path = apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID });
    await alice.send("POST", path, { body: "one", clientId: "c1", attachmentIds: [attachment.id] });
    expect(
      await alice.error("POST", path, { body: "two", clientId: "c2", attachmentIds: [attachment.id] }),
    ).toMatchObject({ status: 404 });
  });
});

describe("downloading", () => {
  it("rechecks membership on every request", async () => {
    const { workspace, alice, aliceId, bob } = setup("file-auth");
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "hidden",
    });
    const channelId = created.channel.id;
    const { attachment } = (await (
      await upload(workspace, aliceId, channelId, PNG, "shot.png")
    ).json()) as UploadResponse;
    await alice.send("POST", apiPath("sendMessage", { channelId }), {
      body: "internal",
      clientId: "c1",
      attachmentIds: [attachment.id],
    });

    expect((await bob.request("GET", filePath(attachment.id))).status).toBe(404);
    expect((await alice.request("GET", filePath(attachment.id))).status).toBe(200);
    // The thumb route serves the same object for now; it is behind the same check.
    expect((await alice.request("GET", filePath(attachment.id, true))).status).toBe(200);
    expect((await bob.request("GET", filePath(attachment.id, true))).status).toBe(404);
  });

  it("answers an error envelope for a malformed file path", async () => {
    // `decodeURIComponent` throws on a lone `%`; a throw inside the object is answered by the
    // runtime with a bare 500 the client cannot parse, so the path is matched rather than decoded.
    const { alice } = setup("file-malformed");
    expect(await alice.error("GET", "/gatekeeper/chat/files/%zz")).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(await alice.error("GET", "/gatekeeper/chat/files/a1/nonsense")).toMatchObject({
      status: 404,
    });
  });

  it("does not serve a pending upload", async () => {
    const { workspace, alice, aliceId } = setup("file-pending");
    const { attachment } = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png")
    ).json()) as UploadResponse;
    expect((await alice.request("GET", filePath(attachment.id))).status).toBe(404);
  });
});

describe("the sweep", () => {
  it("deletes pending objects older than the TTL and leaves attached ones alone", async () => {
    const { workspace, alice, aliceId } = setup("sweep");
    const abandoned = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "abandoned.png")
    ).json()) as UploadResponse;
    const kept = (await (
      await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "kept.png")
    ).json()) as UploadResponse;
    await alice.send("POST", apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }), {
      body: "attached",
      clientId: "c1",
      attachmentIds: [kept.attachment.id],
    });

    // Fresh pending rows survive; only age makes one stale.
    expect(await workspace.sweepUploads()).toBe(1);

    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`UPDATE attachments SET created_at = 0 WHERE message_id IS NULL`);
    });
    expect(await workspace.sweepUploads()).toBe(0);

    // The abandoned row and its object are gone; the attached one is untouched.
    expect((await alice.request("GET", filePath(abandoned.attachment.id))).status).toBe(404);
    expect((await alice.request("GET", filePath(kept.attachment.id))).status).toBe(200);
  });

  it("arms an alarm when an upload is written", async () => {
    const { workspace, aliceId } = setup("sweep-alarm");
    await upload(workspace, aliceId, GENERAL_CHANNEL_ID, PNG, "shot.png");
    const alarm = await runInDurableObject(workspace, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });
});
