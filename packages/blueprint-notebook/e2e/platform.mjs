import assert from 'node:assert/strict';
import { launch, newUserPage, signUp, uploadGadget, createGadgetFromBlueprint, gadgetFrame, createUseShareLink, downloadExport } from '../../blueprint-whiteboard/e2e/platform-helpers.mjs';
import { connectNotebook, connectPython } from './rpc.mjs';
const base = process.env.NOTEBOOK_PLATFORM_URL ?? 'http://localhost:8797';
const browser = await launch();
const errors = [];
let debugPage;
const watchdog = setTimeout(async()=>{
  if(debugPage) { console.error('Notebook UI:',await gadgetFrame(debugPage).locator('body').innerText().catch(()=>'')); await debugPage.screenshot({path:'/tmp/notebook-failure.png'}).catch(()=>{}); }
  await browser.close();
}, 240000);
try {
  const {page} = await newUserPage(browser); debugPage=page;
  page.on('pageerror', e => errors.push(e.message));
  const suffix = crypto.randomUUID().slice(0,8), password = crypto.randomUUID();
  await signUp(page, base, 'notebookowner'+suffix, password);
  const id = await uploadGadget(page, base, new URL('../../../formats/notebook.gadget', import.meta.url).pathname);
  await createGadgetFromBlueprint(page, base, id);
  const workspaceId = new URL(page.url()).pathname.split('/').pop();
  assert.equal(await connectNotebook(page, workspaceId),true);
  const frame = gadgetFrame(page);
  await frame.getByLabel('Notebook title').waitFor({timeout:60000});
  await frame.getByLabel('Notebook title').fill('Notebook browser check');
  await frame.getByLabel('Notebook title').press('Tab');
  await frame.getByText('All changes saved', {exact:true}).waitFor();
  const fixture = {nbformat:4,nbformat_minor:5,metadata:{kernelspec:{language:'python'}},cells:[
    {id:'intro',cell_type:'markdown',source:'# Shared result\n<script>window.__notebookXss=1</script>',metadata:{}},
    {id:'result',cell_type:'code',source:'shared_value = 42\nshared_value',execution_count:1,metadata:{},outputs:[{output_type:'execute_result',execution_count:1,data:{'text/plain':'42','text/html':'<img src=x onerror="window.__notebookXss=1">'},metadata:{}}]}
  ]};
  await frame.locator('input[type=file]').setInputFiles({name:'sample.ipynb',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await frame.locator('.output pre').getByText(/42/).waitFor();
  assert.equal(await frame.locator('.markdown script,.output script,.output img').count(),0);
  const exported = await downloadExport(page, 'Jupyter notebook');
  const data = JSON.parse(exported.text);
  assert.equal(data.cells[1].outputs[0].data['text/plain'],'42');
  assert.equal(data.cells[1].source,'shared_value = 42\nshared_value');
  console.log('PASS: notebook import/export and safe rendering');
  await connectPython(page);
  console.log('Connected Python');
  await frame.getByRole('button',{name:'Run cell'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('iframe[title="Gadget UI"]')!==null);
  await frame.getByRole('button',{name:'Run cell'}).click({timeout:30000});
  console.log('Run requested');

  await frame.locator('.run-state').getByText('succeeded',{exact:true}).waitFor({timeout:90000});
  await frame.locator('.output pre').getByText(/42/).waitFor({timeout:5000});
  const actions = await page.evaluate(async()=>window.notebookTestRpc.workspace.listActions());
  const executed = actions.filter(a=>a.type==='action');
  assert.equal(executed.length,1);
  assert.equal(executed[0].state,'approved');
  assert.equal(executed[0].autoApproved,false);
  assert.ok(executed[0].resolvedBy);
  console.log('PASS: owner execution completed and audited without Activity approval');
  await page.screenshot({path:'/tmp/notebook-browser.png',fullPage:true});
  const share = await createUseShareLink(page);
  const viewer = (await newUserPage(browser)).page; debugPage=viewer;
  await signUp(viewer, base, 'notebookviewer'+suffix, password);
  await viewer.goto(share);
  console.log('Opened viewer link');
  const shared = gadgetFrame(viewer);
  await shared.locator('.output pre').getByText(/42/).waitFor({timeout:60000});
  await shared.getByText(/Shared notebook/).waitFor();
  assert.equal(await shared.getByRole('button',{name:'Run cell'}).isDisabled(),true);
  assert.equal(await shared.getByRole('button',{name:'Stop / reset kernel'}).isDisabled(),true);
  assert.equal(await connectNotebook(viewer,workspaceId),false);
  assert.equal(await viewer.evaluate(async()=>window.notebookTestRpc.gadget.createOwnerActionPermit('PYTHON','a'.repeat(64))),null);
  const forged = await viewer.evaluate(async()=>{
    const client=await window.notebookTestRpc.gadget.connectToGadget();
    try {
      const state=await client.getRuntimeStatus();
      await client.submitRun({requestId:crypto.randomUUID(),sequence:state.sequence,generation:state.generation,operation:'stop',cellId:'',sourceRevision:0,source:''},'forged-permit');
      return 'unexpected success';
    } catch(error) {return error.message;} finally {client[Symbol.dispose]();}
  });
  assert.match(forged,/permit/i);
  const copy = JSON.parse((await downloadExport(viewer,'Jupyter notebook')).text);
  assert.equal(copy.cells[1].source,data.cells[1].source);
  assert.match(copy.cells[1].outputs[0].text,/42/);
  const ownId=await uploadGadget(viewer,base,new URL('../../../formats/notebook.gadget', import.meta.url).pathname);
  await createGadgetFromBlueprint(viewer,base,ownId);
  const clone=gadgetFrame(viewer);
  await clone.getByLabel('Notebook title').waitFor({timeout:60000});
  await clone.locator('input[type=file]').setInputFiles({name:'clone.ipynb',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(copy))});
  await clone.locator('.output pre').getByText(/42/).waitFor();
  await clone.getByText('Connect PYTHON to run cells',{exact:true}).waitFor();
  const cloneWorkspaceId = new URL(viewer.url()).pathname.split('/').pop();
  assert.equal(await connectNotebook(viewer,cloneWorkspaceId),true);
  await connectPython(viewer);
  await clone.getByRole('button',{name:'＋ Code cell'}).click();
  const freshCell=clone.locator('.cell').last();
  await freshCell.locator('.cm-content').fill('print("shared_value" in globals())');
  await freshCell.getByRole('button',{name:'Run cell'}).click({timeout:30000});
  await freshCell.locator('.run-state').getByText('succeeded',{exact:true}).waitFor({timeout:90000});
  await freshCell.locator('.output pre').getByText(/False/).waitFor();
  for (const activePage of [page,viewer]) {
    const activeFrame=gadgetFrame(activePage);
    await activeFrame.getByRole('button',{name:'Stop / reset kernel'}).click();
    await activeFrame.locator('#kernel-info').getByText(/session 2/).waitFor({timeout:30000});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: actual Workshop notebook creation, edit, safe import, saved outputs, export, owner-click Python execution without a second approval, forged viewer permit denial, independent copy with its own executable kernel.');
} catch (error) {
  if(debugPage) { await debugPage.screenshot({path:'/tmp/notebook-failure.png'}).catch(()=>{}); console.error((await debugPage.locator('body').innerText().catch(()=>'' )).slice(0,2000)); }
  throw error;
} finally { clearTimeout(watchdog); await browser.close(); }
