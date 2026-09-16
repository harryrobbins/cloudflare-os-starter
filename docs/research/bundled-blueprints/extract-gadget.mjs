// Extract the files inside a .gadget blueprint archive into a directory.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/var/web/cloudflare-os-starter/cloudflare-os/packages/workshop-backend/package.json");
const Y = require("yjs");

const [archivePath, outDir] = process.argv.slice(2);
const buf = readFileSync(archivePath);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const metaLen = view.getUint32(12);
const contentLen = Number(view.getBigUint64(16));
const meta = JSON.parse(buf.subarray(24, 24 + metaLen).toString("utf8"));
const content = buf.subarray(24 + metaLen, 24 + metaLen + contentLen);
console.log(JSON.stringify(meta, null, 2));
const update = gunzipSync(content);
const doc = new Y.Doc();
Y.applyUpdateV2(doc, new Uint8Array(update));
mkdirSync(outDir, { recursive: true });
for (const [file, text] of doc.getMap()) {
  const p = join(outDir, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text.toString());
  console.log(`${file}\t${text.toString().length} chars`);
}
