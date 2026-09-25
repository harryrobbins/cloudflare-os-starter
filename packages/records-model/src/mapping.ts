import { canonicalIri } from './catalogue.ts';
import { validateRecord, type Profile } from './profile.ts';
export function toJsonLd(profile: Profile, entity: string, record: Record<string, unknown>) {
  const errors = validateRecord(profile, entity, record); if (errors.length) throw new Error(errors.join('; '));
  const definition = profile.entities[entity];
  const output: Record<string, unknown> = { '@type': canonicalIri(definition.term) };
  if (record.id) output['@id'] = record.id;
  for (const [key, field] of Object.entries(definition.fields)) if (record[key] !== undefined) {
    const encode = (value: unknown) => field.type === 'iri' ? {'@id': value} : field.type === 'object' ? {'@value': value, '@type': '@json'} : value;
    output[canonicalIri(field.term)] = field.many ? (record[key] as unknown[]).map(encode) : encode(record[key]);
  }
  return output;
}
/** Deliberately restricted expanded JSON-LD. Never resolves remote contexts. */
export function fromJsonLd(profile: Profile, entity: string, document: Record<string, unknown>) {
  if ('@context' in document) throw new Error('Remote and compact contexts are unsupported; supply expanded IRIs');
  if (canonicalIri(String(document['@type'])) !== canonicalIri(profile.entities[entity]?.term ?? '')) throw new Error('Wrong entity type');
  const data: Record<string, unknown> = {};
  if (document['@id'] !== undefined) data.id = document['@id'];
  const fields = new Map(Object.entries(profile.entities[entity].fields).map(([key, f]) => [canonicalIri(f.term), {key, f}]));
  for (const [term, value] of Object.entries(document)) {
    if (term === '@id' || term === '@type') continue;
    const field = fields.get(canonicalIri(term)); if (!field) throw new Error(`Unmapped semantic field: ${term}`);
    if (Object.hasOwn(data, field.key)) throw new Error('Duplicate semantic alias');
    const decode = (v: unknown) => field.f.type === 'iri' ? (v as Record<string,unknown>)?.['@id'] : field.f.type === 'object' ? ((v as Record<string,unknown>)?.['@type'] === '@json' ? (v as Record<string,unknown>)['@value'] : undefined) : v;
    data[field.key] = field.f.many ? (Array.isArray(value) ? value.map(decode) : value) : decode(value);
  }
  const errors = validateRecord(profile, entity, data); if (errors.length) throw new Error(errors.join('; '));
  return data;
}
export interface StorageMapping { id: string; version: string; entity: string; identityColumn: string; identityPrefix: string; fields: Record<string, { column: string; values?: Record<string, string | number | boolean> }> }
export function mapToCanonical(profile: Profile, mapping: StorageMapping, row: Record<string, unknown>) {
  if (row[mapping.identityColumn] === undefined || row[mapping.identityColumn] === null) throw new Error('Missing storage identity');
  const record: Record<string,unknown> = {id: mapping.identityPrefix + encodeURIComponent(String(row[mapping.identityColumn]))};
  for (const [field, rule] of Object.entries(mapping.fields)) {
    const value = row[rule.column]; if (value === undefined || value === null) continue;
    if (rule.values && !Object.hasOwn(rule.values, String(value))) throw new Error(`Unmapped storage enum: ${field}`);
    record[field] = rule.values ? rule.values[String(value)] : value;
  }
  const errors = validateRecord(profile, mapping.entity, record); if (errors.length) throw new Error(errors.join('; ')); return record;
}
export function mapFromCanonical(profile: Profile, mapping: StorageMapping, record: Record<string, unknown>) {
  const errors = validateRecord(profile, mapping.entity, record); if (errors.length) throw new Error(errors.join('; '));
  if (typeof record.id !== 'string' || !record.id.startsWith(mapping.identityPrefix)) throw new Error('Wrong identity namespace');
  const row: Record<string,unknown> = {[mapping.identityColumn]:decodeURIComponent(record.id.slice(mapping.identityPrefix.length))};
  for (const field of Object.keys(record)) if (field !== 'id' && !Object.hasOwn(mapping.fields, field)) throw new Error(`Unmapped field: ${field}`);
  for (const [field, rule] of Object.entries(mapping.fields)) {
    if (record[field] === undefined) continue;
    const matches = rule.values && Object.entries(rule.values).filter(([,v]) => v === record[field]);
    if (matches && matches.length !== 1) throw new Error(`Noninvertible enum: ${field}`);
    row[rule.column] = matches ? matches[0][0] : record[field];
  }
  return row;
}
