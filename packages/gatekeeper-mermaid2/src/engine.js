/* eslint-disable unicorn/require-post-message-target-origin -- Dedicated workers use transfer lists, not targetOrigin. */
// Both WASM runtimes stay in workers, keeping editing and navigation responsive.
import { prepareInput, preserveFlowDirection } from './input.js';

let converter;
let nextID = 0;
const pending = new Map();
let d2;
let generation = 0;

function resetConverter(error) {
  converter?.terminate();
  converter = undefined;
  for (const operation of pending.values()) operation.reject(error);
  pending.clear();
}

function convert(source) {
  if (!converter) {
    converter = new Worker(new URL('./generated/converter-inline.js', import.meta.url), { type: 'module' });
    converter.addEventListener("message", ({ data }) => {
      if (data.fatal) return resetConverter(new Error(data.fatal));
      const operation = pending.get(data.id);
      if (!operation) return;
      pending.delete(data.id);
      if (data.error) operation.reject(new Error(data.error));
      else operation.resolve(data.source);
    });
    converter.addEventListener("error", event => resetConverter(new Error(event.message || 'Mermaid converter failed.')));
  }
  return new Promise((resolve, reject) => {
    const id = ++nextID;
    pending.set(id, { resolve, reject });
    converter.postMessage({ id, source });
  });
}

export async function renderDiagram({ language, source, theme, sketch, layout = 'tala' }) {
  const run = ++generation;
  const timeoutError = new Error('Layout took longer than 30 seconds. Try a smaller diagram.');
  const checkActive = () => { if (run !== generation) throw timeoutError; };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      generation++;
      resetConverter(timeoutError);
      const previous = d2;
      d2 = undefined;
      previous?.dispose().catch(() => {});
      reject(timeoutError);
    }, 30_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const input = prepareInput(source, language);
        const d2Source = language === 'mermaid' ? preserveFlowDirection(input, await convert(input)) : input;
        checkActive();
        // Keep the large embedded D2 WASM payload out of the initial UI bundle.
        const { D2 } = await import('@d2lang/d2');
        checkActive();
        d2 ??= new D2();
        const engine = d2;
        const { diagram, renderOptions } = await engine.compile(d2Source, {
          layout, themeID: Number(theme), sketch, pad: 36,
        });
        checkActive();
        const svg = await engine.render(diagram, renderOptions);
        return { svg, d2Source, diagram, renderOptions, layout, nodes: diagram.shapes.length, edges: diagram.connections.length };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function renderASCII(diagram, renderOptions) {
  const { D2 } = await import('@d2lang/d2');
  d2 ??= new D2();
  return d2.render(diagram, { ...renderOptions, ascii: true, asciiMode: 'extended' });
}
