// Browser-test API connection. Uses each page's local test account; never prints authentication data.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../gatekeeper-runtime/package.json', import.meta.url));
const capnweb = 'data:text/javascript;base64,' + Buffer.from(await readFile(require.resolve('capnweb').replace(/\.cjs$/, '.js'))).toString('base64');
export async function connectNotebook(page, workspaceId) {
  return page.evaluate(async ({capnweb, workspaceId}) => {
    const rpc = await import(capnweb);
    const socket = new WebSocket(location.origin.replace(/^http/,'ws') + '/api');
    const pub = rpc.newWebSocketRpcSession(socket);
    const api = await pub.authenticate(localStorage.getItem('authToken'));
    const workspace = await api.openGadget(workspaceId);
    const entries = [];
    let ready; const loaded = new Promise(resolve => ready = resolve);
    const subscription = await workspace.subscribeToWorkpieces(new class extends rpc.RpcTarget {
      entry(item) { entries.push(item); } removed() {} ready() { ready(); }
    });
    await loaded; subscription[Symbol.dispose]();
    const gadget = await workspace.getGadget(entries[0].id);
    window.notebookTestRpc = {rpc,socket,pub,api,workspace,gadget};
    return await gadget.canAuthorizeOwnerActions();
  }, {capnweb,workspaceId});
}
export async function connectPython(page) {
  await page.evaluate(async () => {
    const {api,workspace,gadget,rpc} = window.notebookTestRpc;
    await api.provisionAmbientAccount('runtime');
    let account,ready; const loaded = new Promise(resolve=>ready=resolve);
    const subscription = await api.subscribeConnectedAccounts(new class extends rpc.RpcTarget {
      add(id,description,vendor,resources,valid,vendorId) { if(vendorId==='runtime') account=id; }
      remove() {} ready() {ready();}
    });
    await loaded; subscription[Symbol.dispose]();
    if(account===undefined)throw new Error('Python account missing');
    const connection=await workspace.newGatekeeper(account,'python://notebook/browser');
    await gadget.bind('PYTHON',await connection.getId());
    connection[Symbol.dispose]();
  });
}
export async function approveLatest(page) {
  for (let attempt=0; attempt<60; attempt++) {
    const result = await page.evaluate(async()=>{
      const {workspace}=window.notebookTestRpc;
      const actions=await workspace.listActions();
      const action=actions.findLast(a=>a.type==='action'&&a.state==='pending');
      if (!action) return false;
      await workspace.approveAction(action.id); return true;
    });
    if(result) return;
    await page.waitForTimeout(500);
  }
  const status=await page.frameLocator('iframe[title="Gadget UI"]').locator('#notice').textContent();
  throw new Error('No pending action: '+status);
}
