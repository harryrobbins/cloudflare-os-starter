// Opaque ids, shaped so `validate.ts`'s `ID_PATTERN` (`^[A-Za-z0-9_-]{1,64}$`) accepts them.
//
// Time-ordered on purpose: a message id sorts by creation, which makes a test's expectations
// readable and a database dump browsable. Uniqueness comes from the random tail, not the clock, so
// two ids minted in the same millisecond still differ.

const RANDOM_BYTES = 9;

function randomTail(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  let out = "";
  for (const byte of bytes) out += byte.toString(36).padStart(2, "0");
  return out;
}

/** `<prefix>_<millis base36>_<random>`; 1 to 3 characters of prefix. */
function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36)}_${randomTail()}`;
}

export const newMessageId = (now?: number): string => newId("m", now);
export const newChannelId = (now?: number): string => newId("c", now);
export const newAttachmentId = (now?: number): string => newId("a", now);
export const newSessionId = (now?: number): string => newId("s", now);
