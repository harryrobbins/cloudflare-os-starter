export type GraphNode = Record<string, unknown> & { '@id': string };
export interface Vocabulary { '@context': Record<string, string>; '@graph': GraphNode[] }
export function canonicalIri(iri: string): string { return iri.replace(/^http:\/\/schema\.org\//, 'https://schema.org/'); }
export function expandIri(iri: string, context: Record<string, string>): string {
  const colon = iri.indexOf(':');
  return canonicalIri(colon > 0 && context[iri.slice(0, colon)] ? context[iri.slice(0, colon)] + iri.slice(colon + 1) : iri);
}
const array = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export function buildCatalogue(source: Vocabulary) {
  if (!Array.isArray(source['@graph']) || !source['@context']) throw new Error('Expected complete JSON-LD graph');
  const expand = (s: string) => expandIri(s, source['@context']);
  const refs = (v: unknown) => array(v).map(x => expand(typeof x === 'string' ? x : String((x as GraphNode)['@id'])));
  const terms = new Map(source['@graph'].map(raw => {
    const id = expand(raw['@id']);
    const sections = refs(raw['schema:isPartOf']);
    const supersededBy = refs(raw['schema:supersededBy']);
    return [id, { id, types: refs(raw['@type']), parents: refs(raw['rdfs:subClassOf']),
      superProperties: refs(raw['rdfs:subPropertyOf']), domains: refs(raw['schema:domainIncludes']),
      ranges: refs(raw['schema:rangeIncludes']), supersededBy, sections,
      status: sections.some(x => x.includes('attic.schema.org')) ? 'retired' : supersededBy.length ? 'superseded' : sections.some(x => x.includes('pending.schema.org')) ? 'pending' : 'current',
      label: raw['rdfs:label'], description: raw['rdfs:comment'], raw }];
  }));
  return { terms, resolve: (id: string) => terms.get(expand(id)), ancestors(id: string): string[] {
    const found = new Set<string>();
    const visit = (iri: string) => { for (const parent of terms.get(iri)?.parents ?? []) { if (!found.has(parent)) { found.add(parent); visit(parent); } } };
    visit(expand(id)); return [...found].sort();
  }, stats() {
    const schema = [...terms.values()].filter(x => x.id.startsWith('https://schema.org/'));
    return { graphNodes: terms.size, schemaTerms: schema.length, classes: schema.filter(x => x.types.includes('http://www.w3.org/2000/01/rdf-schema#Class')).length,
      properties: schema.filter(x => x.types.includes('http://www.w3.org/1999/02/22-rdf-syntax-ns#Property')).length,
      pending: schema.filter(x => x.status === 'pending').length, retired: schema.filter(x => x.status === 'retired').length,
      superseded: schema.filter(x => x.status === 'superseded').length, multipleInheritance: schema.filter(x => x.parents.length > 1).length };
  } };
}
export type Catalogue = ReturnType<typeof buildCatalogue>;
export function diffCatalogues(previous: Catalogue, next: Catalogue) {
  return {
    added: [...next.terms.keys()].filter(k=>!previous.terms.has(k)).sort(),
    removed: [...previous.terms.keys()].filter(k=>!next.terms.has(k)).sort(),
    changed: [...previous.terms.keys()].filter(k=>next.terms.has(k) && JSON.stringify(previous.terms.get(k)?.raw)!==JSON.stringify(next.terms.get(k)?.raw)).sort(),
  };
}
