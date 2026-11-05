import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../server/store.js';
import {CompactStorage} from '../server/compact-storage.js';
import {fingerprint,sourceReaderCount} from '../server/storage-files.js';
import {stableSourceFingerprint,metadataOnlyChange} from '../server/source-range-identity.js';
import {tags} from '../server/ingest.js';
import {protectDataDirectory} from '../server/local-access.js';
import {transportFixture,sourceStream,collect} from './helpers/source-stream-fixture.js';

async function fixture(t,mode,options={}){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'caibo-metadata-'));
 const f=await transportFixture(root,{seconds:8,start:0,videoBytes:128,...options});
 t.after(async()=>{f.ingest.stop();f.store.close();await fs.rm(root,{recursive:true,force:true});});
 if(mode==='direct'){
  f.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',f.source.id);
  const storage=new CompactStorage(f.store,{isBusy:()=>false});try{await storage.tick();}finally{await storage.close();}
  assert.equal(f.store.get('SELECT mode FROM source_storage WHERE source=?',f.source.id).mode,'direct');
 }
 return f;
}
async function metadataChange(f,mode){
 const files=mode==='direct'?[f.file]:f.store.all('SELECT path FROM chunks WHERE source=?',f.source.id).map(x=>x.path);
 for(const file of files){
  const before=await fs.stat(file,{bigint:true});let after;
  // Windows file-time updates can share a clock tick. Retry only the fixture
  // operation until it has actually produced a distinct status timestamp.
  for(let attempt=0;attempt<5;attempt++){
   await fs.chmod(file,Number(before.mode&0o777n)^0o200);await fs.chmod(file,Number(before.mode&0o777n));
   after=await fs.stat(file,{bigint:true});
   for(const name of ['dev','ino','size','mtimeNs'])assert.equal(after[name],before[name],`fixture changed ${name}`);
   if(after.ctimeNs!==before.ctimeNs)break;
   await delay(20);
  }
  assert.ok(metadataOnlyChange(after,fingerprint(before)),'fixture must change only file status metadata');
 }
}
for(const mode of ['chunks','direct']){
 test(`${mode}: property-only change preserves old preview bytes, random seeks, full-source reads and range identities`,async t=>{
  const f=await fixture(t,mode),ranges=[[0,2],[1.7,3.3],[4.8,7.8]];
  const original=await fs.readFile(f.file),receipts=f.store.all('SELECT * FROM chunk_identities WHERE source=?',f.source.id);
  const expected=await Promise.all(ranges.map(async r=>(await collect(sourceStream(f.store,f.source.id,...r))).bytes));
  const full=(await collect(sourceStream(f.store,f.source.id,0,99,{wholeSource:true}))).bytes;
  const identities=await Promise.all(ranges.map(r=>stableSourceFingerprint(f.store,f.source,...r)));
  await metadataChange(f,mode);
  for(let n=0;n<ranges.length;n++){
   assert.deepEqual((await collect(sourceStream(f.store,f.source.id,...ranges[n]))).bytes,expected[n]);
   assert.equal(await stableSourceFingerprint(f.store,f.source,...ranges[n]),identities[n]);
  }
  assert.deepEqual((await collect(sourceStream(f.store,f.source.id,0,99,{wholeSource:true}))).bytes,full);
  assert.deepEqual(await fs.readFile(f.file),original);
  assert.deepEqual(f.store.all('SELECT * FROM chunk_identities WHERE source=?',f.source.id),receipts,'compatibility must not overwrite saved content receipts');
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
 });
 test(`${mode}: content changes hidden behind metadata-only-looking stats are rejected`,async t=>{
  const f=await fixture(t,mode);
  const chunk=f.store.get('SELECT * FROM chunks WHERE source=? AND seq=0',f.source.id),file=mode==='direct'?f.file:chunk.path;
  const data=await fs.readFile(file);
  if(mode==='direct'){
   const packet=tags(data.subarray(13)).items.find(x=>x.tag[0]===9&&x.tag[12]===1);data[13+packet.offset+18]^=1;
  }else data[18]^=1;
  await fs.writeFile(file,data);
  const current=JSON.parse(fingerprint(await fs.stat(file,{bigint:true})));
  // Model a write whose mtime has been restored; only the SHA-256 receipt can
  // distinguish it from an innocent metadata change.
  current.ctimeNs=String(BigInt(current.ctimeNs)-1n);
  if(mode==='direct')f.store.run('UPDATE source_storage SET fingerprint=? WHERE source=?',JSON.stringify(current),f.source.id);
  else f.store.run('UPDATE chunk_identities SET fingerprint=? WHERE source=? AND seq=0',JSON.stringify(current),f.source.id);
  await assert.rejects(collect(sourceStream(f.store,f.source.id,0,2)),{code:'PREP_SOURCE_STALE'});
  await assert.rejects(stableSourceFingerprint(f.store,f.source,0,2),{code:'PREP_SOURCE_STALE'});
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
 });
}

test('direct: metadata compatibility seeks near the requested range instead of scanning the whole recording',async t=>{
 const f=await fixture(t,'direct',{seconds:120,videoBytes:2048}),expected=(await collect(sourceStream(f.store,f.source.id,100,101))).bytes;
 await metadataChange(f,'direct');
 const open=fs.open.bind(fs);let bytes=0,firstPosition;
 t.mock.method(fs,'open',async(file,...args)=>{
  const handle=await open(file,...args);
  if(file===f.file){const read=handle.read.bind(handle);handle.read=async(...args)=>{firstPosition??=args[3];const result=await read(...args);bytes+=result.bytesRead;return result;};}
  return handle;
 });
 assert.deepEqual((await collect(sourceStream(f.store,f.source.id,100,101))).bytes,expected);
 assert.ok(firstPosition>13,'seek starts from an earlier indexed keyframe');
 assert.ok(bytes<(await fs.stat(f.file)).size/4,`bounded bytes read: ${bytes}`);
 assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('chunks: mutation during a compatible read still fails and releases the file handle',async t=>{
 const f=await fixture(t,'chunks');await metadataChange(f,'chunks');const chunk=f.store.get('SELECT * FROM chunks WHERE source=? AND seq=0',f.source.id),open=fs.open.bind(fs);
 t.mock.method(fs,'open',async(file,...args)=>{
  const handle=await open(file,...args);
  if(file===chunk.path){const read=handle.readFile.bind(handle);handle.readFile=async(...args)=>{const data=await read(...args);await fs.appendFile(file,'changed during read');return data;};}
  return handle;
 });
 await assert.rejects(collect(sourceStream(f.store,f.source.id,0,2)),{code:'PREP_SOURCE_STALE'});
 assert.equal(sourceReaderCount(f.store,f.source.id),0);
 await fs.rename(chunk.path,chunk.path+'.closed');
});

test('Windows: native directory protection and store reopen keep already recorded material readable',{skip:process.platform!=='win32'},async t=>{
 for(const mode of ['chunks','direct']){
  const f=await fixture(t,mode),expected=(await collect(sourceStream(f.store,f.source.id,0,3))).bytes;
  f.ingest.stop();f.store.close();await protectDataDirectory(f.store.root);
  f.store=new Store(f.store.root);
  assert.deepEqual((await collect(sourceStream(f.store,f.source.id,0,3))).bytes,expected);
  assert.ok(await stableSourceFingerprint(f.store,f.source,0,3));
 }
});

test('direct: return and abort during verified compatibility playback release readers and handles',async t=>{
 for(const kind of ['return','abort']){
  const f=await fixture(t,'direct');await metadataChange(f,'direct');
  const controller=new AbortController(),reader=sourceStream(f.store,f.source.id,0,5,{signal:controller.signal});
  for(let n=0;n<4;n++)assert.equal((await reader.next()).done,false);
  if(kind==='return')await reader.return();else{controller.abort();await collect(reader);}
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
  await fs.rename(f.file,f.file+'.closed');
 }
});
