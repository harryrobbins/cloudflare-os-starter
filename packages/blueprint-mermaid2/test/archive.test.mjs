import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArchive } from '../scripts/archive.mjs';
const repo = new URL('../../../', import.meta.url);

test('bundled blueprint includes the connector grant and all three discoverable skills', async () => {
  const {metadata,files}=parseArchive(new Uint8Array(await readFile(new URL('formats/mermaid2.gadget',repo))));
  assert.equal(metadata.bindings.MERMAID2.gatekeeperName,'mermaid2');
  assert.equal(metadata.bindings.MERMAID2.typeUrlPattern,'mermaid2://renderer');
  for(const name of ['mermaid2-connector','mermaid2-blueprint','d2-authoring']) {
    const skill=files[`skills/${name}/SKILL.md`];
    assert.match(skill,new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`));
    assert.match(skill,/\| Task|\| Need/);
  }
  assert.match(files['README.md'],/getDocument/);
  assert.doesNotMatch(files['client.js'],/localStorage|WebAssembly\.instantiate/);
});
