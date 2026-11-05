import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.js';
import {protectDataDirectory} from '../server/local-access.js';
import {checkedFile,fingerprint} from '../server/storage-files.js';
import {stableSourceFingerprint} from '../server/source-range-identity.js';
import {CompactStorage} from '../server/compact-storage.js';
import {transportFixture,sourceStream,collect} from '../test/helpers/source-stream-fixture.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const reports=[];
for(const mode of ['chunks','direct']){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo restart 兼容-'));let store,storage;
 try{
  await protectDataDirectory(root);
  const f=await transportFixture(root,{seconds:8,start:0,videoBytes:128});store=f.store;
  const baseline=hash((await collect(sourceStream(store,f.source.id,0,3))).bytes),original=hash(await fs.readFile(f.file));
  if(mode==='direct'){
   store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',f.source.id);
   storage=new CompactStorage(store,{isBusy:()=>false});await storage.tick();await storage.close();storage=null;
   if(store.get('SELECT mode FROM source_storage WHERE source=?',f.source.id).mode!=='direct')throw new Error('Probe fixture did not compact');
  }
  const receipts=mode==='chunks'?store.all('SELECT chunks.path,chunk_identities.fingerprint FROM chunks JOIN chunk_identities ON chunks.source=chunk_identities.source AND chunks.seq=chunk_identities.seq WHERE chunks.source=?',f.source.id):[{path:f.file,fingerprint:store.get('SELECT fingerprint FROM source_storage WHERE source=?',f.source.id).fingerprint}];
  f.ingest.stop();store.close();store=null;
  await protectDataDirectory(root);
  const changes=[];
  for(const r of receipts){const a=JSON.parse(r.fingerprint),b=JSON.parse(fingerprint(await checkedFile(path.join(root,mode==='chunks'?'chunks':'originals'),r.path)));const fields=Object.keys(a).filter(k=>a[k]!==b[k]);if(fields.length)changes.push(fields);}
  store=new Store(root);
  let playback,error,rangeError;
  try{playback=hash((await collect(sourceStream(store,f.source.id,0,3))).bytes);}catch(e){error={code:e.code,message:e.message};}
  try{await stableSourceFingerprint(store,f.source,0,3);}catch(e){rangeError={code:e.code,message:e.message};}
  reports.push({platform:process.platform,mode,files:receipts.length,changedFiles:changes.length,changedFields:[...new Set(changes.flat())],originalUnchanged:original===hash(await fs.readFile(f.file)),playbackMatches:playback===baseline,error,rangeError});
 }finally{await storage?.close();store?.close();await fs.rm(root,{recursive:true,force:true});}
}
console.log(JSON.stringify({reports},null,2));
if(process.env.CAIBO_MATERIAL_REPORT)await fs.writeFile(process.env.CAIBO_MATERIAL_REPORT,JSON.stringify({reports},null,2)+'\n');
