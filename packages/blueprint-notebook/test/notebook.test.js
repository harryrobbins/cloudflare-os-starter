import { describe, it, expect } from 'vitest';
import { Notebook, importNotebook, exportNotebook, seedNotebook } from '../src/core/notebook.js';
function storage() {
  const data = new Map();
  return { kv: { get: k => structuredClone(data.get(k)), put: (k,v) => data.set(k,structuredClone(v)), delete:k=>data.delete(k) }, transactionSync:fn=>fn() };
}
describe('notebook documents', () => {
  it('retains edits across reconstructed instances and isolates copies', () => {
    const s = storage(), a = new Notebook(s), cell = a.snapshot().cells[1];
    a.saveCell(cell.id, cell.version, 'answer = 42', 'code');
    expect(new Notebook(s).snapshot().cells[1].source).toBe('answer = 42');
    expect(new Notebook(storage()).snapshot().cells[1].source).not.toBe('answer = 42');
  });
  it('rejects stale edits without discarding either draft', () => {
    const n = new Notebook(storage()), c=n.snapshot().cells[1];
    n.saveCell(c.id, c.version, 'first', 'code');
    expect(n.saveCell(c.id,c.version,'second','code')).toMatchObject({conflict:true,cell:{source:'first'}});
  });
  it('version-checks structure changes and enforces source size', () => {
    const n=new Notebook(storage()), s=n.snapshot();
    n.structure(s.revision,{type:'insert',cellType:'markdown'});
    expect(()=>n.structure(s.revision,{type:'delete',id:s.cells[1].id})).toThrow(/changed/);
    expect(()=>n.saveCell(s.cells[1].id,1,'x'.repeat(16001),'code')).toThrow();
  });
  it('records exact output provenance after edits and never rewrites source', () => {
    const n=new Notebook(storage()), c=n.snapshot().cells[1];
    n.saveCell(c.id,1,'different','code');
    n.saveRun({id:'run',cellId:c.id,sourceRevision:1,generation:2,status:'succeeded',text:'42',truncated:false});
    const now=n.snapshot().cells[1];
    expect(now.source).toBe('different');expect(now.version).toBe(2);expect(now.run.sourceRevision).toBe(1);
  });
  it('preserves notebook metadata and unknown MIME output without runtime IDs on export', () => {
    const input={nbformat:4,metadata:{custom:{test:true}},cells:[{id:'a',cell_type:'code',source:['x = 2\n','x'],metadata:{custom:'value'},outputs:[{output_type:'display_data',data:{'text/html':'<script>bad()</script>'},metadata:{}}],execution_count:2}]};
    const d=importNotebook(JSON.stringify(input)); d.cells[0].run={id:'private',generation:3};
    const output=JSON.parse(exportNotebook(d));expect(output.cells[0].source).toBe('x = 2\nx');
    expect(output.metadata.custom).toEqual({test:true});expect(output.cells[0].run).toBeUndefined();expect(output.cells[0].outputs).toEqual(input.cells[0].outputs);
  });
  it('rejects malformed, oversized, and non-Python files before storage', () => {
    expect(()=>importNotebook('{')).toThrow();
    expect(()=>importNotebook(JSON.stringify({nbformat:4,metadata:{language_info:{name:'R'}},cells:[]}))).toThrow(/Python/);
    expect(()=>importNotebook(' '.repeat(1000001))).toThrow(/large/);
    expect(()=>importNotebook(JSON.stringify({nbformat:4,cells:Array(101).fill({cell_type:'code',source:''})}))).toThrow();
  });
  it('bounds saved output without losing source or failing the refresh', () => {
    const n = new Notebook(storage()), doc = n.snapshot(), c = doc.cells[1];
    c.metadata = { large: 'x'.repeat(60000) }; c.source = 'x'.repeat(16000); n.replace(doc);
    expect(n.saveRun({id:'run',cellId:c.id,sourceRevision:1,generation:0,status:'succeeded',text:'x'.repeat(12000),png:'a'.repeat(24000),truncated:false})).toBe(true);
    const saved = n.snapshot().cells[1]; expect(saved.source).toBe(c.source); expect(saved.run.truncated).toBe(true);
    expect(JSON.stringify(saved).length).toBeLessThan(100000);
  });
  it('rejects malformed output collections before storage', () => {
    expect(()=>importNotebook(JSON.stringify({nbformat:4,cells:[{cell_type:'code',source:'',outputs:{}}]}))).toThrow(/outputs/);
  });
  it('moves/deletes cells and bounds total document content', () => {
    const n=new Notebook(storage());let d=n.snapshot();
    d=n.structure(d.revision,{type:'move',id:'first-cell',index:0});expect(d.cells[0].id).toBe('first-cell');
    d=n.structure(d.revision,{type:'delete',id:'welcome'});expect(d.cells).toHaveLength(1);
    const huge=seedNotebook();huge.cells=Array.from({length:100},(_,i)=>({id:'c'+i,type:'code',source:'字'.repeat(16000),version:1}));
    expect(()=>n.replace(huge)).toThrow(/storage/);
  });
});
