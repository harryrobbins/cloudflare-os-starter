/** Initial local/server file-secret generation. Creates a NEW directory; never rotates live keys. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint } from 'jose';
const directory=process.argv[2];if(!directory)throw new Error('Usage: prepare-secrets.ts <new-absolute-secret-directory>');
if(!directory.startsWith('/'))throw new Error('Use an absolute directory outside the checkout');
const target=resolve(directory);
await mkdir(target,{mode:0o700});
const write=(name:string,value:string)=>writeFile(join(target,name),value+'\n',{flag:'wx',mode:0o600});
const passwords=Object.fromEntries(['postgres','authenticator','gateway','listener'].map(role=>[role,randomBytes(32).toString('hex')]));
for(const [role,password] of Object.entries(passwords))await write(`${role}_password`,password);
for(const role of ['gateway','listener'])await write(`${role}_database_url`,`postgres://records_${role}:${passwords[role]}@db:5432/records`);
const {publicKey,privateKey}=await generateKeyPair('ES256',{extractable:true});
const jwk=await exportJWK(publicKey);const kid=await calculateJwkThumbprint(jwk);
await write('signing.pem',await exportPKCS8(privateKey));await write('signing_kid',kid);
await write('jwks.json',JSON.stringify({keys:[{...jwk,kid,alg:'ES256',use:'sig'}]}));
await write('postgrest.conf',[
 `db-uri = "postgres://records_authenticator:${passwords.authenticator}@db:5432/records"`,
 'db-schemas = "records_api"','db-pre-request = "records_api.pre_request"',
 'jwt-secret = "@/run/secrets/jwks"','jwt-aud = "records"','db-max-rows = 500',
 'db-pool = 10','server-port = 3000','server-host = "0.0.0.0"',
].join('\n'));
console.log('File secrets created. Values were not printed. Keep this directory private and backed up separately.');
