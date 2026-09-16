import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
it('persists document state through real Durable Object RPC and exports notebook data', async () => {
  const n=env.GADGET.getByName(crypto.randomUUID());
  let d=await n.getNotebook();
  await n.saveCell(d.cells[1].id,1,'print(42)','code');
  expect(JSON.parse(await n.exportNotebook()).cells[1].source).toBe('print(42)');
  expect(await n.getRuntimeStatus()).toEqual({connected:false});
  const other=env.GADGET.getByName(crypto.randomUUID());expect((await other.getNotebook()).cells[1].source).not.toBe('print(42)');
});
it('returns conflicts across independent clients and refuses execution without a connection', async () => {
  const n=env.GADGET.getByName(crypto.randomUUID()); const d=await n.getNotebook();
  await n.saveCell(d.cells[1].id,1,'print(1)','code');
  expect(await n.saveCell(d.cells[1].id,1,'print(2)','code')).toMatchObject({conflict:true});
  await expect((async () => await n.submitRun({requestId:crypto.randomUUID(),operation:'execute',sequence:0,generation:0,cellId:d.cells[1].id,sourceRevision:2,source:'print(1)'},'fake'))()).rejects.toThrow(/Connect/);
});
