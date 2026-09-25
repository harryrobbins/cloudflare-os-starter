import { cp, mkdir, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/', root), { recursive: true });
await cp(new URL('public/', root), new URL('dist/', root), { recursive: true });
await cp(new URL('../../../docs/plans/external_datastores/records-direction.md', import.meta.url), new URL('dist/architecture-plan.md', root));
await cp(new URL('../../../docs/plans/external_datastores/records-blueprint-adaptation.md', import.meta.url), new URL('dist/blueprint-adaptation-plan.md', root));
await cp(new URL('../../../docs/plans/external_datastores/records-explorer-blueprint.md', import.meta.url), new URL('dist/explorer-blueprint-plan.md', root));
console.log('Built Records website in sites/records/dist');
