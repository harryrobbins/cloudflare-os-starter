// Shared by the core and the source adapters.

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * A rejection that means the binding does not have the method at all (a KV namespace, another
 * gatekeeper, a plain object): an answer, not a transient failure, so it is never retried.
 */
export function isMissingMethod(error) {
  if (error instanceof TypeError && /is not a function/.test(error.message)) return true
  return /does not implement|not implemented|no such method|unknown method|method .*(not found|missing|does not exist)|is not a function/i.test(message(error))
}
