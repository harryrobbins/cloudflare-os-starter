import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { assetPath, CSP } from '../../gatekeeper-mermaid2/src/browser-policy.ts';

const require=createRequire(import.meta.url);
const capnweb=await readFile(require.resolve('capnweb').replace(/\.cjs$/, '.js'),'utf8');
const capnUrl='data:text/javascript;base64,'+Buffer.from(capnweb).toString('base64');
const client=await readFile(new URL('../dist/client.js',import.meta.url),'utf8');
const server=(await readFile(new URL('../src/server/index.js',import.meta.url),'utf8')).replace("import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';",'const {DurableObject,WorkerEntrypoint}=globalThis.__mermaid2TestRuntime;');
globalThis.__mermaid2TestRuntime={DurableObject:class{constructor(ctx,env){this.ctx=ctx;this.env=env;}},WorkerEntrypoint:class{}};
const {Gadget}=await import('data:text/javascript;base64,'+Buffer.from(server).toString('base64'));
delete globalThis.__mermaid2TestRuntime;
const gadgetCSP="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";

test('blueprint UI works through RPC in the real Workshop sandbox, persists drafts and prepares files', {timeout:120000}, async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const renderer=await browser.newPage();
    await renderer.route('**/*',async route=>{
      const path=assetPath(route.request().url());if(path===null)return route.abort();
      const body=await readFile(new URL('../../gatekeeper-mermaid2/dist-renderer/'+(path==='/'?'index.html':path.slice(1)),import.meta.url));
      return route.fulfill({body,headers:{'content-type':path.endsWith('.js')?'application/javascript':'text/html','content-security-policy':CSP}});
    });
    await renderer.goto('https://mermaid2-renderer.invalid/');
    await renderer.waitForFunction(()=>typeof globalThis.renderMermaiD2==='function');
    const entries=new Map();
    const render=async input=>{
      const request={language:'d2',layout:'tala',format:'svg',theme:104,sketch:false,scale:2,...input};
      const output=await renderer.evaluate(r=>globalThis.renderMermaiD2(r),request);
      return {...output,filename:`mermaid2-diagram.${output.extension}`,data:Uint8Array.from(Buffer.from(output.base64,'base64')),layout:request.layout,language:request.language,format:request.format};
    };
    const doc=new Gadget({storage:{kv:{get:k=>entries.get(k),put:(k,v)=>entries.set(k,v)}}},{MERMAID2:{render}});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message.replace(/data:[^'"\s]+/g,'data:…').slice(0,300)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,300));});
    await page.exposeFunction('getDoc',()=>doc.getDocument());
    await page.exposeFunction('setDoc',input=>doc.setDocument(input));
    await page.exposeFunction('renderRemote',async input=>{const file=await render(input);delete file.data;return file;});
    const prefix=`import {newMessagePortRpcSession} from ${JSON.stringify(capnUrl)};let gadget;{const {port1,port2}=new MessageChannel();gadget=newMessagePortRpcSession(port1);parent.postMessage('handshake','*',[port2]);}\n`;
    const html=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${gadgetCSP}"><script type="module" src="data:text/javascript;base64,${Buffer.from(prefix+client).toString('base64')}"></script>`;
    await page.setContent('<style>body{margin:0}iframe{border:0;width:100%;height:100vh}</style><iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>');
    await page.addScriptTag({type:'module',content:`import {RpcTarget,newMessagePortRpcSession} from ${JSON.stringify(capnUrl)};class Host extends RpcTarget {getDocument(){return getDoc();}setDocument(input){return setDoc(input);}async renderDiagram(input){const file=await renderRemote(input);file.data=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));delete file.base64;return file;}};addEventListener('message',event=>{if(event.data==='handshake')newMessagePortRpcSession(event.ports[0],new Host());});`});
    await page.evaluate(content=>document.querySelector('iframe').srcdoc=content,html);
    const frame=page.frameLocator('iframe');
    try { await expect(frame.locator('#status')).toHaveText('Rendered with TALA',{timeout:15000}); } catch(error) { console.log('Sandbox diagnostic:',errors); throw error; }
    await expect(frame.locator('#diagram-stage > img')).toBeVisible();
    await expect(frame.locator('#save-status')).toHaveText('Saved in this gadget');
    await frame.getByRole('textbox',{name:'Diagram source'}).fill('flowchart LR\n A[Persistent draft] --> B[Works]');
    await expect(frame.locator('#status')).toHaveText('Rendered with TALA');
    await expect(frame.locator('#save-status')).toHaveText('Saved in this gadget');
    assert.match(doc.getDocument().drafts.mermaid,/Persistent draft/);
    await frame.getByLabel('Layout',{exact:true}).selectOption('elk');
    await expect(frame.locator('#status')).toHaveText('Rendered with ELK');
    await expect(frame.locator('#save-status')).toHaveText('Saved in this gadget');
    await page.evaluate(content=>document.querySelector('iframe').srcdoc=content,html);
    await expect(frame.locator('#status')).toHaveText('Rendered with ELK');
    await expect(frame.getByRole('textbox',{name:'Diagram source'})).toContainText('Persistent draft');
    await frame.getByLabel('Export format').selectOption('png');
    await frame.getByRole('button',{name:'Export',exact:true}).click();
    await expect(frame.getByRole('dialog')).toBeVisible();
    await expect(frame.getByRole('link',{name:'Open mermaid2-diagram.png'})).toHaveAttribute('target','_blank');
    await frame.getByRole('button',{name:'Close',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth),390);
    await page.screenshot({path:'/tmp/mermaid2-blueprint-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
