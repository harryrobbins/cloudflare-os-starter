// Structured logs: one JSON line per event, no document text and no principal ids in them.

export function logEvent(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
