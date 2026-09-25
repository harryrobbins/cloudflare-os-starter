/** Snapshot only deployable source. Never includes local credentials or the dirty root checkout. */
import { mkdtemp, readdir, readFile, mkdir, writeFile, copyFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const repo=fileURLToPath(new URL('../../..',import.meta.url));
const output=resolve(process.argv[2]??'/tmp');
const paths=['sites/records/public','docs/plans/external_datastores/records-direction.md','docs/plans/external_datastores/records-blueprint-adaptation.md','docs/plans/external_datastores/records-explorer-blueprint.md','packages/records-service/src','packages/records-service/scripts','packages/records-service/sql',...['README.md','homeserver.md','migrate.ts','prepare-secrets.ts','package-release.ts','deploy-homeserver.sh','compose.yaml','homeserver.compose.yaml','tunnel.compose.yaml','install-tunnel-token.ts','runtime/package.json','runtime/pnpm-lock.yaml'].map(name=>'packages/records-service/deploy/'+name),'packages/records-service/package.json','packages/records-service/Dockerfile','packages/records-service/Dockerfile.dockerignore','packages/records-model/src','packages/records-model/catalogue','packages/records-model/profiles','packages/records-model/package.json','packages/records-model/README.md'];
const stage=await mkdtemp(join(tmpdir(),'records-release-'));const hashes:Record<string,string>={};
async function include(path:string):Promise<void>{
 const full=join(repo,path);const stat=await lstat(full);
 if(stat.isSymbolicLink())throw new Error(`Symlink not allowed in release: ${path}`);
 if(stat.isDirectory()) {for(const entry of (await readdir(full)).sort()){if(entry.startsWith('.')||entry==='node_modules')continue;await include(path+'/'+entry);}return;}
 if(!stat.isFile())throw new Error('Only regular files belong in a release');
 const bytes=await readFile(full);hashes[path]=createHash('sha256').update(bytes).digest('hex');
 await mkdir(dirname(join(stage,path)),{recursive:true});await writeFile(join(stage,path),bytes,{mode:0o644});
}
try{
 for(const path of paths)await include(path);
 const ordered=Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
 const release=createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
 await writeFile(join(stage,'release.json'),JSON.stringify({format:1,release,files:ordered},null,2)+'\n');
 await mkdir(output,{recursive:true});const archive=join(output,`records-${release.slice(0,16)}.tar.gz`);
 await exec('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',archive,'-C',stage,'.']);
 await copyFile(join(stage,'release.json'),archive+'.manifest.json');
 console.log(JSON.stringify({release,archive,sha256:createHash('sha256').update(await readFile(archive)).digest('hex'),files:Object.keys(hashes).length}));
}finally{await rm(stage,{recursive:true,force:true});}
