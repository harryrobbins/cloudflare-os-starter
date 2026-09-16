import { describe, expect, it } from 'vitest';
import { parseArchive } from '../scripts/archive.mjs';
import { packArchive } from '../scripts/pack-gadget.mjs';

describe('notebook blueprint archive', () => {
  it('requires a Notebook Python connection bound as PYTHON', () => {
    const bytes = packArchive(
      { 'server.js': '', 'client.js': '', 'README.md': '' },
      {
        title: 'Notebook',
        description: 'Python notebook',
        author: { type: 'user', name: 'Test', id: 'test@example.com' },
        output: { id: 'notebook', noun: 'Notebook', plural: 'Notebooks', icon: 'notebook' },
        revision: 1,
      },
    );

    expect(parseArchive(bytes).metadata.bindings).toEqual({
      PYTHON: {
        title: 'Python kernel',
        description: 'A private Python kernel for running notebook cells and sharing saved results.',
        type: 'gatekeeper',
        gatekeeperName: 'runtime',
        typeUrlPattern: 'python://notebook/:name',
      },
    });
  });
});
