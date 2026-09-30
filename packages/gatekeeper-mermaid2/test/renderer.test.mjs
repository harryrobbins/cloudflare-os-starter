import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assetPath, CSP } from '../src/browser-policy.ts';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('real private renderer handles both languages, three engines and every format under its CSP', {timeout: 180000}, async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.route('**/*', async route => {
      const path = assetPath(route.request().url());
      if (path === null) return route.abort();
      const body=await readFile(join(root, 'dist-renderer', path === '/' ? 'index.html' : path.slice(1)));
      return route.fulfill({body,headers:{'content-type':path.endsWith('.js')?'application/javascript':'text/html','content-security-policy':CSP}});
    });
    await page.goto('https://mermaid2-renderer.invalid/');
    await page.waitForFunction(()=>typeof globalThis.renderMermaiD2==='function');
    for(const language of ['d2','mermaid']) for(const layout of ['tala','dagre','elk']) {
      const source=language==='d2'?'a: Client\nb: API\na -> b':'flowchart LR\n a[Client] --> b[API]';
      const result=await page.evaluate(input=>globalThis.renderMermaiD2(input),{source,language,layout,format:'svg',theme:104,sketch:false,scale:1});
      assert.match(Buffer.from(result.base64,'base64').toString(),/<svg/);
      assert.equal(result.nodes,2);assert.equal(result.edges,1);
    }
    for(const format of ['png','jpeg','webp','pdf','ascii','source','d2','json']) {
      const result=await page.evaluate(input=>globalThis.renderMermaiD2(input),{source:'a: Client\nb: API\na -> b',language:'d2',layout:'tala',format,theme:104,sketch:false,scale:1});
      const bytes=Buffer.from(result.base64,'base64'); assert.ok(bytes.length>20);
      if(format==='png') assert.equal(bytes.subarray(1,4).toString(),'PNG');
      if(format==='jpeg') assert.equal(bytes.subarray(0,2).toString('hex'),'ffd8');
      if(format==='webp') assert.equal(bytes.subarray(8,12).toString(),'WEBP');
      if(format==='pdf') assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      if(format==='ascii') assert.match(bytes.toString(),/Client/);
      if(format==='json') assert.equal(JSON.parse(bytes.toString()).layout,'tala');
    }
    const denied=await page.evaluate(async()=>{
      try { await fetch('https://example.com/private'); return false; } catch { return true; }
    });
    assert.equal(denied,true);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
