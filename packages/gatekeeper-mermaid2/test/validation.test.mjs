import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, CAPABILITIES } from '../src/validation.ts';
import { assetPath, CSP } from '../src/browser-policy.ts';

test('validates input and option limits before browser allocation', () => {
  const defaults = normalizeRequest({ source: 'a -> b' });
  assert.equal(defaults.layout, 'tala'); assert.equal(defaults.format, 'svg');
  for (const input of [{source:''}, {source:'😀'.repeat(25001)}, {source:'a',language:'pie'}, {source:'a',layout:'force'}, {source:'a',format:'html'}, {source:'a',scale:100}, {source:'a',theme:999}, {source:'a',sketch:'true'}]) assert.throws(() => normalizeRequest(input), /invalid_request/);
  assert.equal(CAPABILITIES.externalResources, false);
});

test('only private trusted renderer assets pass the browser network policy', () => {
  assert.equal(assetPath('https://mermaid2-renderer.invalid/'), '/');
  assert.equal(assetPath('https://mermaid2-renderer.invalid/assets/chunk-ABC.js'), '/assets/chunk-ABC.js');
  for (const url of ['https://example.com/', 'https://127.0.0.1/main.js', 'http://mermaid2-renderer.invalid/main.js', 'https://mermaid2-renderer.invalid/main.js?source=secret', 'https://mermaid2-renderer.invalid/api', 'https://mermaid2-renderer.invalid/assets/file.wasm']) assert.equal(assetPath(url), null);
  assert.match(CSP, /connect-src data: blob:/);
  assert.match(CSP, /worker-src blob:/);
});
