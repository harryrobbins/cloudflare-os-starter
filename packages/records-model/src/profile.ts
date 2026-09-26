import { canonicalIri, type Catalogue } from './catalogue.ts';
export interface Field { term: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'iri' | 'object'; required?: boolean; /** Present only for readers the module's rules allow (for example the owner); absent otherwise. */ restricted?: boolean; many?: boolean; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; enum?: (string | number | boolean)[]; reference?: string }
export interface Entity { term: string; fields: Record<string, Field> }
export interface Profile { id: string; version: string; vocabulary?: { id: string; version: string }; entities: Record<string, Entity> }
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const safeName = (value: unknown): value is string => typeof value === 'string' && identifier.test(value) && !['__proto__','prototype','constructor'].includes(value);
export const identifier = /^[a-z][a-z0-9_]{0,62}$/;
/** Record metadata set by the service (revision, attribution, ownership), never data fields. */
export const reservedFields = ['id', 'revision', 'created_by', 'updated_by', 'created_at', 'updated_at', 'owner', 'datastore_id', '__proto__', 'constructor', 'prototype'];
export const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const absoluteIri = (s: unknown): s is string => typeof s === 'string' && /^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(s);
export function validateProfile(profile: Profile, catalogue?: Catalogue): string[] {
  const errors: string[] = [];
  if (!isObject(profile)) return ['profile must be an object'];
  if (profile.vocabulary !== undefined && (!isObject(profile.vocabulary) || !absoluteIri(profile.vocabulary.id) || typeof profile.vocabulary.version !== 'string' || !profile.vocabulary.version)) errors.push('invalid vocabulary pin');
  if (!absoluteIri(profile.id)) errors.push('profile.id must be an absolute IRI');
  if (typeof profile.version !== 'string' || !semver.test(profile.version)) errors.push('profile.version must be a release semver');
  if (!isObject(profile.entities) || !Object.keys(profile.entities).length) return [...errors, 'entities must not be empty'];
  const checkTerm = (term: string, location: string) => {
    if (!absoluteIri(term)) { errors.push(`${location}: absolute term IRI required`); return; }
    if (canonicalIri(term).startsWith('https://schema.org/')) {
      if (!profile.vocabulary || profile.vocabulary.id !== 'https://schema.org/') errors.push(`${location}: Schema.org terms require a pinned vocabulary`);
      if (catalogue && !catalogue.resolve(term)) errors.push(`${location}: unknown Schema.org term`);
    }
  };
  for (const [name, entity] of Object.entries(profile.entities)) {
    if (!safeName(name)) errors.push(`invalid entity name: ${name}`);
    if (!isObject(entity) || !isObject(entity.fields)) { errors.push(`${name}: entity and fields must be objects`); continue; }
    checkTerm(entity.term, name);
    const terms = new Set<string>();
    for (const [key, field] of Object.entries(entity.fields)) {
      const location = `${name}.${key}`;
      if (!isObject(field)) { errors.push(`${location}: field must be an object`); continue; }
      if (!identifier.test(key) || reservedFields.includes(key)) errors.push(`${location}: reserved or invalid field name`);
      checkTerm(field.term, location);
      if (typeof field.term !== 'string') continue;
      if (terms.has(canonicalIri(field.term))) errors.push(`${location}: duplicate term mapping`);
      terms.add(canonicalIri(field.term));
      if (!['string', 'number', 'integer', 'boolean', 'iri', 'object'].includes(field.type)) errors.push(`${location}: unsupported type`);
      if (field.reference && (!Object.hasOwn(profile.entities,field.reference) || field.type !== 'iri')) errors.push(`${location}: invalid reference`);
      if (field.restricted && field.required) errors.push(`${location}: a restricted field cannot be required`);
      for (const flag of ['required','restricted','many'] as const) if (field[flag] !== undefined && typeof field[flag] !== 'boolean') errors.push(`${location}: ${flag} must be boolean`);
      if (Array.isArray(field.enum) && field.enum.some(value => field.type === 'integer' ? !Number.isSafeInteger(value) : field.type === 'iri' ? !absoluteIri(value) : typeof value !== field.type)) errors.push(`${location}: enum type mismatch`);
      if ((field.minLength !== undefined || field.maxLength !== undefined) && !['string','iri'].includes(field.type)) errors.push(`${location}: length bounds require string or IRI`);
      if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.some(v=> !['string','number','boolean'].includes(typeof v)))) errors.push(`${location}: invalid enum`);
      for (const bound of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
        if (field[bound] !== undefined && (!Number.isSafeInteger(field[bound]) || field[bound]! < 0)) errors.push(`${location}: invalid ${bound}`);
      }
      if ((field.minItems !== undefined || field.maxItems !== undefined) && !field.many) errors.push(`${location}: item bounds require many`);
      if ((field.minItems ?? 0) > (field.maxItems ?? Infinity) || (field.minLength ?? 0) > (field.maxLength ?? Infinity)) errors.push(`${location}: inverted bounds`);
    }
  }
  return errors;
}
export function validateRecord(profile: Profile, entityName: string, data: unknown): string[] {
  const entity = Object.hasOwn(profile.entities,entityName) ? profile.entities[entityName] : undefined;
  if (!entity) return ['unknown entity'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['record must be an object'];
  const record = data as Record<string, unknown>; const errors: string[] = [];
  if (record.id !== undefined && !absoluteIri(record.id)) errors.push('id: absolute IRI required');
  for (const key of Object.keys(record)) if (key !== 'id' && !Object.hasOwn(entity.fields, key)) errors.push(`${key}: unknown field`);
  for (const [key, f] of Object.entries(entity.fields)) {
    const value = record[key];
    if (value === undefined) { if (f.required) errors.push(`${key}: required`); continue; }
    if (f.many && !Array.isArray(value)) { errors.push(`${key}: array required`); continue; }
    if (!f.many && Array.isArray(value)) { errors.push(`${key}: scalar required`); continue; }
    const values = f.many ? value as unknown[] : [value];
    if (f.many && (values.length < (f.minItems ?? 0) || values.length > (f.maxItems ?? Infinity))) errors.push(`${key}: cardinality`);
    for (const item of values) {
      const valid = f.type === 'object' ? item !== null && typeof item === 'object' && !Array.isArray(item) : f.type === 'iri' ? absoluteIri(item) : f.type === 'integer' ? Number.isSafeInteger(item) : f.type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === f.type;
      if (!valid) errors.push(`${key}: expected ${f.type}`);
      if (f.enum && !f.enum.includes(item as string)) errors.push(`${key}: not an allowed value`);
      if (typeof item === 'string' && ([...item].length < (f.minLength ?? 0) || [...item].length > (f.maxLength ?? Infinity))) errors.push(`${key}: length`);
    }
  }
  return errors;
}
export function recordJsonSchema(profile: Profile, entityName: string) {
  const entity = Object.hasOwn(profile.entities,entityName) ? profile.entities[entityName] : undefined; if (!entity) throw new Error('unknown entity');
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    required: Object.entries(entity.fields).filter(([,f]) => f.required).map(([k]) => k),
    properties: Object.fromEntries([['id', {type:'string',format:'uri'}], ...Object.entries(entity.fields).map(([k,f]) => {
      const item = {type: f.type === 'iri' ? 'string' : f.type, ...(f.type === 'iri' ? {format:'uri'} : {}), ...(f.restricted && !f.many ? {'x-records-restricted':true} : {}), ...(f.enum ? {enum:f.enum} : {}), ...(f.minLength !== undefined ? {minLength:f.minLength}:{}), ...(f.maxLength !== undefined ? {maxLength:f.maxLength}: {})};
      return [k, f.many ? {type:'array',items:item,...(f.restricted ? {'x-records-restricted':true} : {}),...(f.minItems !== undefined ? {minItems:f.minItems}:{}),...(f.maxItems !== undefined ? {maxItems:f.maxItems}:{})} : item];
    })]) };
}
