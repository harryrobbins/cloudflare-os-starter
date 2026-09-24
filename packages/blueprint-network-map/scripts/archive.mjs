// Reads and writes Cloudflare OS `.gadget` blueprint archives.
//
// The authority on the format is cloudflare-os/packages/workshop-backend/src/blueprint-archive.ts:
// a 24-byte big-endian prefix (u64 magic, u32 version, u32 metadata length, u64 content length),
// UTF-8 JSON metadata, then a gzipped Yjs V2 update whose unnamed root map holds
// `file name -> Y.Text`. Mirrors upstream's scripts/import-format-blueprint.mjs.

import { gunzipSync, gzipSync } from "node:zlib";
import * as Y from "yjs";

const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

/**
 * Encodes files into the gzipped Yjs snapshot a blueprint carries. Deterministic: fixed client id,
 * files inserted in sorted order, gzip without a timestamp.
 * @param {Record<string, string>} files
 */
export function encodeContent(files) {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const root = doc.getMap();
  doc.transact(() => {
    for (const name of Object.keys(files).toSorted()) {
      const text = new Y.Text();
      root.set(name, text);
      text.insert(0, files[name]);
    }
  });
  return new Uint8Array(gzipSync(Y.encodeStateAsUpdateV2(doc), { level: 9 }));
}

/** @param {Uint8Array} content */
export function decodeContent(content) {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, new Uint8Array(gunzipSync(content)));
  /** @type {Record<string, string>} */
  const files = {};
  for (const [name, text] of doc.getMap()) files[name] = text.toString();
  return files;
}

/**
 * @param {object} metadata BlueprintMetadata as JSON (dates as ISO strings)
 * @param {Uint8Array} content
 */
export function serializeArchive(metadata, content) {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) throw new Error("metadata exceeds 64 KiB");
  if (content.byteLength > MAX_CONTENT_BYTES) throw new Error("content exceeds 32 MiB");
  const out = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metadataBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return out;
}

/** @param {Uint8Array} bytes */
export function parseArchive(bytes) {
  if (bytes.byteLength < PREFIX_BYTES) throw new Error("too short to be a .gadget archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0) !== MAGIC) throw new Error("not a .gadget archive (bad magic)");
  const version = view.getUint32(8);
  if (version !== VERSION) throw new Error(`unsupported archive version ${version}`);
  const metadataLength = view.getUint32(12);
  const contentLength = Number(view.getBigUint64(16));
  const content = bytes.subarray(PREFIX_BYTES + metadataLength);
  if (content.byteLength !== contentLength) {
    throw new Error(`content is ${content.byteLength} bytes, prefix claims ${contentLength}`);
  }
  const metadata = JSON.parse(
    new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength)));
  return { metadata, files: decodeContent(content) };
}
