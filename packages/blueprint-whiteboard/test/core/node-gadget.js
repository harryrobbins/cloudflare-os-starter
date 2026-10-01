// @ts-check
// The real Gadget class (src/server/index.js) in plain Node over in-memory Durable Object storage,
// the same stand-in the blueprint eval runner uses (scripts/blueprint-evals/node-gadget.mjs).
// `cloudflare:workers` is aliased to test/fixtures/cloudflare-workers.js in vitest.config.ts.
import { Gadget } from "../../src/server/index.js";
import { MemoryStorage } from "../../../../scripts/blueprint-evals/node-gadget.mjs";

export function nodeGadget() {
  const ctx = { storage: new MemoryStorage(), id: { toString: () => "test", name: "test" }, waitUntil() {}, blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn() };
  return /** @type {any} */ (new Gadget(/** @type {any} */ (ctx), {}));
}

/** Runs executeCode-style code (a function body using `env`) against `env`. @param {string} code @param {any} env */
export function runCode(code, env) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("self", "env", "ctx", code)({}, env, { waitUntil() {} });
}

/**
 * A small JSON Schema check covering what describeGadget() uses: type (or a list), enum,
 * properties, required, items, anyOf, pattern, minimum, maximum, maxItems. Returns problems.
 * @param {any} schema @param {unknown} value @param {string} [path]
 * @returns {string[]}
 */
export function validate(schema, value, path = "input") {
  if (!schema || typeof schema !== "object") return [];
  if (schema.anyOf) {
    return schema.anyOf.some((/** @type {any} */ s) => validate(s, value, path).length === 0) ? [] : [`${path}: matches no anyOf branch`];
  }
  /** @type {string[]} */
  const out = [];
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null || value === undefined ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some((/** @type {string} */ t) => t === actual || (t === "integer" && Number.isInteger(value)));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${path}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (k in value) out.push(...validate(s, /** @type {any} */ (value)[k], `${path}.${k}`));
    }
  }
  return out;
}
