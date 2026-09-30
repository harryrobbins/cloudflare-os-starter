/* eslint-disable unicorn/require-post-message-target-origin -- Dedicated workers use transfer lists, not targetOrigin. */
import './generated/wasm_exec.js';

let initialization;
async function initialize() {
  const go = new globalThis.Go();
  const response = await fetch(new URL('./generated/converter.wasm', import.meta.url));
  if (!response.ok) throw new Error('Could not load the Mermaid converter.');
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
  go.run(instance).catch((error) => {
    self.postMessage({ fatal: error.message });
  });
  if (typeof globalThis.mermaidToD2 !== 'function') throw new Error('Mermaid converter did not initialize.');
}

self.addEventListener("message", async ({ data: { id, source } }) => {
  try {
    initialization ??= initialize().catch((error) => { initialization = undefined; throw error; });
    await initialization;
    const result = JSON.parse(globalThis.mermaidToD2(source));
    self.postMessage({ id, ...result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});
