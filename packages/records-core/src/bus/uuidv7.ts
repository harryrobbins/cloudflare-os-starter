// UUIDv7 (RFC 9562 §5.7): 48-bit Unix milliseconds, version 7, variant 10, 74 random bits. Sorts
// by creation time, which keeps journal change IDs index-friendly. PostgreSQL 17 has no uuidv7(),
// and the service generates IDs itself anyway so they are known before the insert.

export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
