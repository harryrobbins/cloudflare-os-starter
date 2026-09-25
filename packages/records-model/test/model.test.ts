import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCatalogue, validateProfile, validateRecord, toJsonLd, fromJsonLd, mapToCanonical, mapFromCanonical, recordJsonSchema, preparePublication, type Profile, type StorageMapping, type ModuleManifest } from '../src/index.ts';
const read = (path: string) => JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
const catalogue = buildCatalogue(read('catalogue/schemaorg-30.1.jsonld'));
const work: Profile = read('profiles/work-example.json');
test('complete pinned graph, aliases, multiple inheritance and status survive import', () => {
  const pin = read('catalogue/provenance.json');
  assert.equal(createHash('sha256').update(readFileSync(new URL('../catalogue/'+pin.file,import.meta.url))).digest('hex'),pin.sha256);
  assert.deepEqual(catalogue.stats(),{graphNodes:3259,schemaTerms:3026,classes:940,properties:1540,pending:181,retired:3,superseded:95,multipleInheritance:57});
  assert.equal(catalogue.resolve('http://schema.org/Project'),catalogue.resolve('schema:Project'));
  assert.ok(catalogue.ancestors('schema:Project').includes('https://schema.org/Organization'));
  assert.ok([...catalogue.terms.values()].some(t=>t.parents.length>1));
  assert.equal(catalogue.resolve('schema:StupidType')?.status,'retired');
  assert.ok(catalogue.resolve('schema:name')!.domains.length);
  assert.ok(catalogue.resolve('schema:name')!.ranges.length);
});
test('supplied, extended and blank profiles validate; fabricated schema terms fail',()=>{
  for(const file of ['work','messaging','extended','custom']) assert.deepEqual(validateProfile(read('profiles/'+file+'.json'),catalogue),[]);
  const broken=structuredClone(work);broken.entities.work_item.term='https://schema.org/Issue';
  assert.match(validateProfile(broken,catalogue).join(),/unknown Schema.org term/);
});
test('constraints reject type, enum, missing, cardinality and unexpected fields',()=>{
  assert.deepEqual(validateRecord(work,'work_item',{name:'Read',status:'todo'}),[]);
  for(const data of [{name:'Read',status:'nonsense'},{name:3,status:'todo'},{name:['Read'],status:'todo'},{status:'todo'},{name:'',status:'todo'},{name:'Read',status:'todo',secret:1}]) assert.ok(validateRecord(work,'work_item',data).length);
  const profile=structuredClone(work);profile.entities.work_item.fields.name.many=true;profile.entities.work_item.fields.name.minItems=1;
  assert.ok(validateRecord(profile,'work_item',{name:[],status:'todo'}).includes('name: cardinality'));
  assert.equal(recordJsonSchema(work,'work_item').additionalProperties,false);
});
test('JSON-LD roundtrip preserves custom fields and identifiers; no remote fetching',()=>{
  const profile=read('profiles/extended.json');const record={id:'urn:work:item:1',name:'Write',status:'doing',project:'urn:work:project:7',priority:2};
  assert.deepEqual(fromJsonLd(profile,'work_item',toJsonLd(profile,'work_item',record)),record);
  assert.throws(()=>fromJsonLd(profile,'work_item',{'@context':'https://attacker.invalid/context'}),/contexts/);
  assert.throws(()=>fromJsonLd(profile,'work_item',{'@type':'urn:records:work:WorkItem','urn:unknown':'value'}),/Unmapped/);
});
test('two physical schemas yield one model with invertible explicit enum mappings',()=>{
  const first:StorageMapping={id:'urn:map:a',version:'1.0.0',entity:'work_item',identityColumn:'key',identityPrefix:'urn:work:',fields:{name:{column:'title'},status:{column:'state',values:{OPEN:'todo',DONE:'done'}}}};
  const second:StorageMapping={...first,id:'urn:map:b',identityColumn:'issue_id',fields:{name:{column:'summary'},status:{column:'progress',values:{new:'todo',complete:'done'}}}};
  const a={key:'42',title:'Task',state:'OPEN'},b={issue_id:'42',summary:'Task',progress:'new'};
  assert.deepEqual(mapToCanonical(work,first,a),mapToCanonical(work,second,b));
  assert.deepEqual(mapFromCanonical(work,first,mapToCanonical(work,first,a)),a);
  assert.throws(()=>mapToCanonical(work,first,{...a,state:'UNKNOWN'}),/Unmapped/);
});
test('publication verifies declared migration bytes, duplicate IDs and command scope',()=>{
  const sql='CREATE TABLE example (id uuid PRIMARY KEY);';
  const manifest:ModuleManifest={id:'work',version:'1.0.0',apiMajor:1,profile:work,scopes:['work.read','work.write'],commands:{'work.create':{entity:'project',scope:'work.write'}},migrations:[{id:'0001_initial',sha256:createHash('sha256').update(sql).digest('hex')}]};
  assert.equal(preparePublication(manifest,{'0001_initial':sql},catalogue).requiresPrivilegedReview,true);
  assert.throws(()=>preparePublication(manifest,{'0001_initial':sql+' '},catalogue),/checksum/);
  assert.throws(()=>preparePublication({...manifest,migrations:[...manifest.migrations,...manifest.migrations]},{'0001_initial':sql},catalogue),/duplicate/);
  assert.throws(()=>preparePublication({...manifest,commands:{'work.create':{entity:'project',scope:'admin.write'}}},{'0001_initial':sql},catalogue),/invalid command/);
});

test('executable SQL profiles use concrete work and messaging fields',()=>{
  const work = read('profiles/work.json'); const messaging = read('profiles/messaging.json');
  const record={id:'urn:uuid:123',title:'Build',status:'active',extensions:{custom:{nested:1}}};
  assert.deepEqual(validateRecord(work,'work_item',record),[]);
  assert.deepEqual(fromJsonLd(work,'work_item',toJsonLd(work,'work_item',record)),record);
  assert.deepEqual(validateRecord(messaging,'message',{channel:'general',body:'Hello'}),[]);
  assert.ok(validateRecord(messaging,'message',{channel:'',body:'Hello'}).length);
});
test('upgrade rejects migration edits and same-major constraints, accepts additive optional fields',async()=>{
  const {validateUpgrade,diffCatalogues}=await import('../src/index.ts');
  const previous:ModuleManifest={id:'work',version:'1.0.0',apiMajor:1,profile:work,scopes:['work.read','work.write'],commands:{'work.create':{entity:'project',scope:'work.write',handler:'records_work.create(uuid,text,jsonb,bigint,bigint)'}},migrations:[{id:'0001_initial',sha256:'a'.repeat(64)}]};
  const next=structuredClone(previous);next.version='1.1.0';next.profile.entities.project.fields.notes={term:'urn:work:notes',type:'string'};
  assert.deepEqual(validateUpgrade(previous,next),[]);
  next.profile.entities.project.fields.notes.required=true;
  assert.match(validateUpgrade(previous,next).join(),/required field added/);
  next.migrations[0].sha256='b'.repeat(64);
  assert.match(validateUpgrade(previous,next).join(),/migration changed/);
  assert.deepEqual(diffCatalogues(catalogue,catalogue),{added:[],removed:[],changed:[]});
});
test('independent inventory module prepares with trusted SQL and no Schema.org dependency',()=>{
  const manifest=read('examples/inventory/module.json');
  const sources=Object.fromEntries(manifest.migrations.map((m:{id:string})=>[m.id,readFileSync(new URL(`../examples/inventory/migrations/${m.id}.sql`,import.meta.url),'utf8')]));
  assert.equal(preparePublication(manifest,sources,catalogue).manifest.id,'inventory');
  assert.deepEqual(validateRecord(manifest.profile,'asset',{label:'Laptop',serial:'SN42'}),[]);
  assert.ok(validateRecord(manifest.profile,'asset',{label:'Laptop',serial:''}).length);
});
test('bundled catalogue and SQL profiles are available without network',async()=>{
  const {getBundledCatalogue,getRuntimeProfile}=await import('../src/bundled.ts');
  assert.equal(getBundledCatalogue().stats().schemaTerms,3026);
  assert.equal(getRuntimeProfile('work')!.entities.work_item.fields.title.maxLength,500);
  assert.equal(getRuntimeProfile('unknown'),undefined);
});

test('malformed manifests and prototype names fail closed with actionable validation',async()=>{
 const {validateModule}=await import('../src/index.ts');
 for(const input of [null,[],{}, {profile:null}, {profile:{id:'urn:test',version:'1.0.0',entities:{x:null}}}, {profile:{id:'urn:test',version:'1.0.0',entities:{x:{term:null,fields:{}}}}}]) {
  assert.ok(validateModule(input as never).length);assert.throws(()=>preparePublication(input as never,{}));
 }
 const baseline=read('examples/inventory/module.json');
 for(const overrides of [{commands:{'inventory.x':null}},{migrations:[null]},{scopes:[null]},{id:'constructor'},{commands:{'inventory.x':{entity:'constructor',scope:'inventory.write'}}}]) assert.ok(validateModule({...baseline,...overrides}).length);
 const profile=structuredClone(baseline.profile);profile.entities.asset.fields.serial=null;assert.ok(validateProfile(profile).length);
 assert.ok(validateRecord(baseline.profile,'constructor',{}).length);
 assert.throws(()=>recordJsonSchema(baseline.profile,'constructor'),/unknown entity/);
});
test('restricted fields are optional, marked in JSON Schema, and metadata names are reserved',()=>{
  const manifest=read('examples/people/module.json');
  const sources={'0001_initial':readFileSync(new URL('../examples/people/migrations/0001_initial.sql',import.meta.url),'utf8')};
  assert.equal(preparePublication(manifest,sources,catalogue).manifest.id,'people');
  assert.deepEqual(validateRecord(manifest.profile,'profile',{name:'Ada'}),[],'a masked record is still valid');
  const schema=recordJsonSchema(manifest.profile,'profile') as {required:string[];properties:Record<string,Record<string,unknown>>};
  assert.equal(schema.properties.email['x-records-restricted'],true); assert.ok(!schema.required.includes('email'));
  const required=structuredClone(manifest.profile);required.entities.profile.fields.email.required=true;
  assert.ok(validateProfile(required).some(e=>/restricted field cannot be required/.test(e)));
  for(const name of ['owner','created_by','updated_by','revision']){
    const clash=structuredClone(manifest.profile);clash.entities.profile.fields[name]={term:`urn:test:${name}`,type:'string'};
    assert.ok(validateProfile(clash).some(e=>/reserved/.test(e)),name);
  }
});
