// Deterministic connector fixtures. A fresh factory per eval prevents state leaking between runs.
// Reuse the existing Records protocol fakes, including their approval and permission checks.
import { fileURLToPath } from 'node:url';
import { requireFromBlueprints } from './node-gadget.mjs';

// Compile TypeScript dependencies too (some protocol fakes use parameter properties).
async function fixtureModule(path) {
  const result = await requireFromBlueprints('esbuild').build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, format: 'esm', platform: 'node', target: 'es2022', write: false });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { FakeRecords: ProjectRecords } = await fixtureModule('../../packages/blueprint-project-board/test/fake-records.js');
const { FakeRecords: WorkRecords } = await fixtureModule('../../packages/blueprint-work-board/test/fake-records.js');

export function projectsEnvironment() { return { RECORDS: new ProjectRecords() }; }
export function recordsEnvironment() { return { RECORDS: new WorkRecords({ access: 'read' }).session() }; }
export function workEnvironment() { return { RECORDS: new WorkRecords({ access: 'write' }).session() }; }
export function pythonEnvironment() {
  return { PYTHON: { async getStatus() { return { generation: 1, sequence: 0, active: null, packages: [] }; } } };
}
export function diagramEnvironment() {
  return { MERMAID2: {
    async render(request) {
      // The renderer is external; this fixture checks transport and UI plumbing, not D2 layout.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="white"/><text x="10" y="40">Fixture diagram</text></svg>';
      return { data: new TextEncoder().encode(svg), contentType: 'image/svg+xml', d2Source: request.source, nodes: 2, edges: 1 };
    },
  } };
}
export function syntheticEnvironment() {
  const rows = Array.from({ length: 24 }, (_, i) => ({ id: String(i + 1), amount: (i + 1) * 10, region: i % 2 ? 'North' : 'South' }));
  const schema = { name: 'orders', title: 'Orders', primaryKey: 'id', exactRecords: rows.length,
    indexes: [{ fields: ['region'], operators: ['eq'] }],
    fields: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'region', type: 'string' }] };
  const select = request => rows.filter(row => (request.predicates ?? []).every(p => {
    const value = row[p.field];
    if (p.operator === 'eq') return value === p.value;
    if (p.operator === 'gt') return value > p.value;
    if (p.operator === 'gte') return value >= p.value;
    if (p.operator === 'lt') return value < p.value;
    if (p.operator === 'lte') return value <= p.value;
    throw new Error('Unsupported predicate');
  }));
  return { PROCGEN: {
    async describeDataset() { return { scenario: 'retail', version: '1', seedLabel: 'eval', sizeProfile: 'small' }; },
    async listCollections() { return [{ ...schema }]; },
    async describeCollection(name) { if (name !== 'orders') throw new Error('Unknown collection'); return schema; },
    async getRecord(name, id) { if (name !== 'orders') throw new Error('Unknown collection'); return rows.find(row => row.id === id) ?? null; },
    async query(request) {
      if (request.collection !== 'orders') throw new Error('Unknown collection');
      const all = select(request), offset = Number(request.cursor ?? 0), end = offset + (request.limit ?? 50);
      return { schema, records: all.slice(offset, end).map(row => request.fields ? Object.fromEntries(request.fields.map(field => [field, row[field]])) : row), nextCursor: end < all.length ? String(end) : null };
    },
    async aggregate(request) {
      const all = select(request);
      const metrics = Object.fromEntries(request.metrics.map(m => {
        const values = all.map(row => row[m.field]);
        const value = m.function === 'count' ? all.length : m.function === 'sum' ? values.reduce((a,b) => a+b,0) : m.function === 'min' ? Math.min(...values) : m.function === 'max' ? Math.max(...values) : values.reduce((a,b) => a+b,0) / values.length;
        return [m.name, value];
      }));
      return { groups: [{ key: {}, metrics }], ...metrics };
    },
    async table(request) {
      if (request.collection !== 'orders') throw new Error('Unknown collection');
      const selected = rows.slice(0, request.limit ?? rows.length);
      return { columns: schema.fields, data: schema.fields.map(field => selected.map(row => row[field.name])), rowCount: selected.length, totalRows: rows.length };
    },
  } };
}
