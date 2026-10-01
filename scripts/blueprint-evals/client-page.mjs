// Opens a gadget's client in headless Chromium the way the platform runs it: client.lib.js then
// client.js as one module, after a prefix declaring the module-scope `gadget`, `gadgetViewer` and
// `RpcTarget` (GadgetUI.tsx, INJECTED_CODE_PREFIX). `gadget` is bridged to a server instance in
// Node (node-gadget.mjs). Arguments and results cross as JSON; RpcTarget instances and functions
// passed by the client become callable stubs on the Node side, as Cap'n Web would make them.

import { assembleClientCode } from "../gadget-entry.mjs";

const VIEWER = { id: "eval.person@example.com", displayName: "Eval Person", role: "owner" };

const PAGE_RUNTIME = `(() => {
  class RpcTarget {}
  const targets = new Map();
  let next = 1;
  const enc = (v) => {
    if (typeof v === "function" || v instanceof RpcTarget) { const id = next++; targets.set(id, v); return { __evalTarget: id }; }
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
    }
    return v;
  };
  globalThis.__EvalRpcTarget = RpcTarget;
  globalThis.__evalCallTarget = (id, method, args) => {
    const t = targets.get(id);
    return method === null ? t(...args) : t[method](...args);
  };
  const gadget = new Proxy({}, {
    get(_, m) {
      if (typeof m !== "string" || m === "then") return undefined;
      if (m === "dup") return () => gadget;
      return (...args) => globalThis.__evalRpc(m, JSON.stringify(enc(args)))
        .then((r) => (r === undefined || r === null ? undefined : JSON.parse(r, (_key, value) => value?.__evalBytes ? new Uint8Array(value.__evalBytes) : value)));
    },
  });
  globalThis.__evalGadget = gadget;
})();`;

const PREFIX = `//# sourceURL=client.js
const RpcTarget = globalThis.__EvalRpcTarget;
let gadget = globalThis.__evalGadget;
const gadgetViewer = Object.freeze(${JSON.stringify(VIEWER)});
`;

/**
 * @param {object} o
 * @param {import("playwright").Browser} o.browser
 * @param {Record<string, string>} o.files
 * @param {any} o.gadget  server instance
 * @returns {Promise<{page: import("playwright").Page, errors: string[]}>}
 */
export async function openClient({ browser, files, gadget }) {
  const code = assembleClientCode(files["client.js"] ?? "", files["client.lib.js"]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.stack ?? e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const stub = (/** @type {number} */ id) => {
    const call = (/** @type {string|null} */ method, /** @type {unknown[]} */ args) =>
      page.evaluate(([i, m, a]) => /** @type {any} */ (globalThis).__evalCallTarget(i, m, a), [id, method, JSON.parse(JSON.stringify(args ?? []))])
        .catch(() => undefined); // the page may have closed
    /** @type {any} */
    const proxy = new Proxy(function () {}, {
      apply: (_t, _this, args) => call(null, args),
      get(_t, m) {
        if (m === "then" || typeof m === "symbol") return m === Symbol.dispose ? () => {} : undefined;
        if (m === "dup") return () => proxy;
        return (/** @type {unknown[]} */ ...args) => call(m, args);
      },
    });
    return proxy;
  };
  const dec = (/** @type {any} */ v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") {
      if (typeof v.__evalTarget === "number") return stub(v.__evalTarget);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
    }
    return v;
  };
  await page.exposeFunction("__evalRpc", async (/** @type {string} */ method, /** @type {string} */ argsJson) => {
    if (method === "$canAuthorizeOwnerActions") return "false";
    if (typeof gadget[method] !== "function") throw new Error(`The gadget has no RPC method ${method}()`);
    const result = await gadget[method](...dec(JSON.parse(argsJson)));
    return result === undefined ? undefined : JSON.stringify(result, (_key, value) => value instanceof Uint8Array ? { __evalBytes: [...value] } : value);
  });
  await page.setContent("<!DOCTYPE html><html><head></head><body></body></html>");
  await page.addScriptTag({ content: PAGE_RUNTIME });
  await page.addScriptTag({ type: "module", content: PREFIX + code });
  return { page, errors };
}
