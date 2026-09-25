import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildCatalogue } from '../src/catalogue.ts';
import { validateProfile } from '../src/profile.ts';
const root = new URL('../catalogue/', import.meta.url);
const pin = JSON.parse(await readFile(new URL('provenance.json',root),'utf8'));
const command = process.argv[2] ?? 'verify';
if (command === 'import') {
  const response = await fetch(pin.source); if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Pinned upstream checksum mismatch; explicit release review required');
  await writeFile(new URL(pin.file,root),bytes);
}
const bytes = await readFile(new URL(pin.file,root));
if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('Catalogue checksum mismatch');
const catalogue = buildCatalogue(JSON.parse(bytes.toString()));
if (command === 'validate') {
  const errors = validateProfile(JSON.parse(await readFile(process.argv[3], 'utf8')),catalogue);
  if (errors.length) throw new Error(errors.join('; ')); console.log('Profile valid');
} else if (['verify','stats','import'].includes(command)) console.log(JSON.stringify({version:pin.version,sha256:pin.sha256,...catalogue.stats()},null,2));
else throw new Error('Usage: catalogue.ts verify|stats|import|validate <profile.json>');
