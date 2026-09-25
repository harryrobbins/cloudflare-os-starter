import { readFileSync } from 'node:fs';
import work from '../profiles/work.json' with { type: 'json' };
import messaging from '../profiles/messaging.json' with { type: 'json' };
import { buildCatalogue, type Vocabulary } from './catalogue.ts';
import type { Profile } from './profile.ts';
let cached: ReturnType<typeof buildCatalogue> | undefined;
export function getBundledCatalogue() { return cached ??= buildCatalogue(JSON.parse(readFileSync(new URL('../catalogue/schemaorg-30.1.jsonld',import.meta.url),'utf8')) as Vocabulary); }
export function getRuntimeProfile(module: string): Profile | undefined {
  const profile = module === 'work' ? work : module === 'messaging' ? messaging : undefined;
  return profile ? structuredClone(profile) as Profile : undefined;
}
