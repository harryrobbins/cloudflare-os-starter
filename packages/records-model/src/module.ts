import { createHash } from 'node:crypto';
import { isObject, safeName, semver, validateProfile, type Profile } from './profile.ts';
import type { Catalogue } from './catalogue.ts';
export interface ModuleManifest { id: string; version: string; apiMajor: number; profile: Profile; scopes: string[]; commands: Record<string, {entity: string; scope: string; handler?: string}>; migrations: {id: string; sha256: string}[] }
export function validateModule(manifest: ModuleManifest, catalogue?: Catalogue): string[] {
  if (!isObject(manifest)) return ['module must be an object'];
  const errors = validateProfile(manifest.profile, catalogue);
  if (!Array.isArray(manifest.scopes) || !isObject(manifest.commands) || !Array.isArray(manifest.migrations)) return [...errors, 'scopes/migrations must be arrays; commands must be an object'];
  if (errors.length) return errors;
  if (!safeName(manifest.id)) errors.push('invalid module id');
  if (typeof manifest.version !== 'string' || !semver.test(manifest.version)) errors.push('invalid module version');
  if (!Number.isSafeInteger(manifest.apiMajor) || manifest.apiMajor < 1) errors.push('invalid API major');
  if (new Set(manifest.scopes).size !== manifest.scopes.length || manifest.scopes.some(x => typeof x !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(x))) errors.push('invalid or duplicate scopes');
  if (!manifest.scopes.includes(`${manifest.id}.read`)) errors.push('module requires its namespaced read scope');
  if (manifest.scopes.some(scope => typeof scope === 'string' && !scope.startsWith(`${manifest.id}.`))) errors.push('scope must belong to module namespace');
  for (const [name, command] of Object.entries(manifest.commands)) {
    if (!isObject(command)) { errors.push(`invalid command: ${name}`); continue; }
    if (!name.startsWith(`${manifest.id}.`)) errors.push(`command must belong to module namespace: ${name}`);
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(name) || !Object.hasOwn(manifest.profile.entities,command.entity) || !manifest.scopes.includes(command.scope)) errors.push(`invalid command: ${name}`);
  }
  for (const command of Object.values(manifest.commands)) if (isObject(command) && command.handler && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\(uuid,text,jsonb,bigint,bigint\)$/.test(command.handler)) errors.push('invalid SQL handler signature');
  if (manifest.migrations.some(m=>!isObject(m))) return [...errors, 'migration must be an object'];
  if (new Set(manifest.migrations.map(x => x.id)).size !== manifest.migrations.length) errors.push('duplicate migration id');
  if (manifest.migrations.some((m,i) => i > 0 && m.id <= manifest.migrations[i-1].id)) errors.push('migrations must be in increasing ID order');
  for (const m of manifest.migrations) if (typeof m.id !== 'string' || typeof m.sha256 !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(m.id) || !/^[a-f0-9]{64}$/.test(m.sha256)) errors.push('invalid migration descriptor');
  return errors;
}
export function preparePublication(manifest: ModuleManifest, migrations: Record<string,string>, catalogue?: Catalogue) {
  const errors = validateModule(manifest, catalogue);
  if (errors.length) throw new Error(errors.join('; '));
  if (!isObject(migrations) || Object.values(migrations).some(s=>typeof s !== 'string')) throw new Error('migration sources must be strings');
  for (const m of manifest.migrations) {
    if (!Object.hasOwn(migrations,m.id) || createHash('sha256').update(migrations[m.id]).digest('hex') !== m.sha256) errors.push(`migration checksum mismatch: ${m.id}`);
  }
  for (const key of Object.keys(migrations)) if (!manifest.migrations.some(m => m.id === key)) errors.push(`undeclared migration: ${key}`);
  if (errors.length) throw new Error(errors.join('; '));
  return { manifest: structuredClone(manifest), migrations: manifest.migrations.map(m => ({...m,sql:migrations[m.id]})), requiresPrivilegedReview:true };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (isObject(value)) return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
/** Release pinning guard; compatibility requires separately reviewed contract fixtures. */
export function validateUpgrade(previous: ModuleManifest, next: ModuleManifest): string[] {
  const errors = [...validateModule(previous), ...validateModule(next)];
  if (errors.length) return errors;
  if (previous.profile.id !== next.profile.id) errors.push('profile identity changed');
  if (previous.id !== next.id) errors.push('module identity changed');
  const compare = (a:string,b:string) => {const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt);return x[0]-y[0] || x[1]-y[1] || x[2]-y[2];};
  if (compare(next.version,previous.version) <= 0) errors.push('upgrade requires a strictly newer release');
  if (next.apiMajor < previous.apiMajor) errors.push('API major cannot decrease');
  for (const [index,m] of previous.migrations.entries()) if (next.migrations[index]?.id!==m.id || next.migrations[index]?.sha256!==m.sha256) errors.push(`applied migration changed or removed: ${m.id}`);
  if (previous.apiMajor === next.apiMajor) {
    for (const scope of previous.scopes) if (!next.scopes.includes(scope)) errors.push(`scope removed: ${scope}`);
    for (const [name,command] of Object.entries(previous.commands)) if (!next.commands[name] || next.commands[name].entity!==command.entity || next.commands[name].scope!==command.scope) errors.push(`command contract changed: ${name}`);
    for (const [name,entity] of Object.entries(previous.profile.entities)) {
      const target=next.profile.entities[name];
      if (!target || target.term!==entity.term) {errors.push(`entity changed: ${name}`);continue;}
      for (const [key,field] of Object.entries(entity.fields)) if (canonical(target.fields[key])!==canonical(field)) errors.push(`field change requires compatibility review: ${name}.${key}`);
      for (const [key,field] of Object.entries(target.fields)) if (!entity.fields[key] && field.required) errors.push(`required field added: ${name}.${key}`);
    }
  }
  return errors;
}
