import DOMPurify from 'dompurify';
import { renderDiagram } from '../src/engine.js';
import { exportDiagram } from '../src/export.js';

// Trusted code only; source remains a string passed to the two WASM engines.
globalThis.renderMermaiD2 = async (request) => {
  if (request.format === 'source') {
    return { base64: encode(new TextEncoder().encode(request.source)), extension: request.language === 'mermaid' ? 'mmd' : 'd2', contentType: 'text/plain;charset=utf-8', nodes: 0, edges: 0 };
  }
  const result = await renderDiagram(request);
  if (result.nodes > 1000 || result.edges > 2000) throw new Error('Diagram exceeds the 1,000-node or 2,000-edge limit.');
  result.svg = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
  const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
  for (const image of svg.querySelectorAll('image')) {
    const href = image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href && !href.startsWith('data:') && !href.startsWith('#')) throw new Error('External images are unavailable; use embedded data URLs.');
  }
  result.source = request.source;
  result.language = request.language;
  const { blob, extension } = await exportDiagram(result, request.format, request.scale);
  if (blob.size > 16 * 1024 * 1024) throw new Error('Generated file exceeds 16 MiB. Use a lower scale or SVG.');
  return { base64: encode(new Uint8Array(await blob.arrayBuffer())), extension, contentType: blob.type, nodes: result.nodes, edges: result.edges, d2Source: result.d2Source };
};
function encode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
