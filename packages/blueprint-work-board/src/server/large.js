// @ts-check
// Documents larger than one storage value (reports up to 256 KiB, proposals up to 128 KiB). The
// platform caps a value at 128 KiB and V8 stores numbers larger than JSON does, so a document is
// stored as its JSON text: the head key holds the text when it is short, otherwise the text is
// split into parts of at most 48,000 characters under `<key>#<n>`. Strings of JSON serialise at
// about one byte per character, far inside the cap.

const PART = 48_000;

/**
 * @typedef {{ get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<boolean|void>, list: (options: { prefix: string }) => Promise<Map<string, any>> }} Storage
 */

/** @param {Storage} storage @param {string} key @param {unknown} value */
export async function putLarge(storage, key, value) {
  const text = JSON.stringify(value);
  const old = await storage.get(key);
  const parts = Math.ceil(text.length / PART);
  if (parts <= 1) await storage.put(key, { json: text });
  else {
    for (let i = 0; i < parts; i++) await storage.put(`${key}#${i}`, text.slice(i * PART, (i + 1) * PART));
    await storage.put(key, { parts });
  }
  // Parts left over from a longer earlier version.
  for (let i = parts <= 1 ? 0 : parts; i < (old?.parts ?? 0); i++) await storage.delete(`${key}#${i}`);
}

/** @param {Storage} storage @param {string} key @returns {Promise<any>} */
export async function getLarge(storage, key) {
  return decode(storage, key, await storage.get(key));
}

/** @param {Storage} storage @param {string} key @param {any} head */
async function decode(storage, key, head) {
  if (!head) return null;
  if (typeof head.json === "string") return JSON.parse(head.json);
  if (Number.isInteger(head.parts)) {
    let text = "";
    for (let i = 0; i < head.parts; i++) text += (await storage.get(`${key}#${i}`)) ?? "";
    return JSON.parse(text);
  }
  return head;
}

/** @param {Storage} storage @param {string} key */
export async function deleteLarge(storage, key) {
  const head = await storage.get(key);
  for (let i = 0; i < (head?.parts ?? 0); i++) await storage.delete(`${key}#${i}`);
  return storage.delete(key);
}

/** Every document under a prefix (parts skipped). @param {Storage} storage @param {string} prefix */
export async function listLarge(storage, prefix) {
  const out = [];
  for (const [key, head] of await storage.list({ prefix })) {
    if (key.includes("#")) continue;
    out.push(await decode(storage, key, head));
  }
  return out.filter(Boolean);
}
