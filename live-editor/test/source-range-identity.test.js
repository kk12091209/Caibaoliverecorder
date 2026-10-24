import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompactStorage} from '../server/compact-storage.js';
import {sourceReaderCount} from '../server/storage-files.js';
import {tags,timestamp} from '../server/ingest.js';
import {stableSourceFingerprint,stableSourceRangeStatus,codecHeaderSignature} from '../server/source-range-identity.js';
import {transportFixture,flvTag,sourceStream,collect} from './helpers/source-stream-fixture.js';

async function setup(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-range-identity-'));
  const fixture=await transportFixture(root,{seconds:8,start:0,videoBytes:128,live:true,...options});
  t.after(async()=>{fixture.ingest.stop();fixture.store.close();await fs.rm(root,{recursive:true,force:true});});
  return fixture;
}
async function append(fixture,from,to,{header}={}) {
  const packets=header?[header]:[];
  for(let second=from;second<to;second++)for(let n=0;n<4;n++)packets.push(flvTag(9,second*1000+n*250,128,{key:n===0}));
  await fs.appendFile(fixture.file,Buffer.concat(packets));await fixture.ingest.tick();
}
async function finish(fixture) {
  fixture.store.run('UPDATE sources SET closed=1 WHERE id=?',fixture.source.id);await fixture.ingest.tick();
  fixture.store.run("UPDATE sessions SET status='finished' WHERE id=?",fixture.session.id);
}
async function compact(fixture) {
  fixture.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',fixture.source.id);
  const storage=new CompactStorage(fixture.store,{isBusy:()=>false});
  try{await storage.tick();}finally{await storage.close();}
  assert.equal(fixture.store.get('SELECT mode FROM source_storage WHERE source=?',fixture.source.id).mode,'direct');
}

test('已封口旧区间身份不随追加、索引进度、关闭或重启状态变化，尾部必须有封口保护',async t=>{
  const fixture=await setup(t),{store,source}=fixture;
  assert.equal(stableSourceRangeStatus(store,source,0,2).ready,true);
  assert.equal(stableSourceRangeStatus(store,source,4,6.5).reason,'tail');
  const before=await stableSourceFingerprint(store,source,0,2);
  await append(fixture,8,13);
  assert.equal(await stableSourceFingerprint(store,source,0,2),before);
  assert.equal(stableSourceRangeStatus(store,source,4,6.5).ready,true);
  await finish(fixture);
  assert.equal(await stableSourceFingerprint(store,source,0,2),before);
  assert.equal(sourceReaderCount(store,source.id),0);
});

test('验证整理前后范围指纹相同，删除chunks后继续使用已核验媒体摘要和原片身份',async t=>{
  const fixture=await setup(t),{store,source}=fixture;await finish(fixture);
  const ranges=[[0,2],[2.25,5.25],[6.3,7.7]],before=await Promise.all(ranges.map(args=>stableSourceFingerprint(store,source,...args)));
  const streams=await Promise.all(ranges.map(args=>collect(sourceStream(store,source.id,...args))));
  await compact(fixture);
  assert.deepEqual(await Promise.all(ranges.map(args=>stableSourceFingerprint(store,source,...args))),before);
  for(let n=0;n<ranges.length;n++)assert.deepEqual((await collect(sourceStream(store,source.id,...ranges[n]))).bytes,streams[n].bytes);
  const stat=await fs.stat(fixture.file);await fs.utimes(fixture.file,stat.atime,new Date(stat.mtimeMs+1000));
  await assert.rejects(stableSourceFingerprint(store,source,0,2),{code:'PREP_SOURCE_STALE'});
  assert.equal(sourceReaderCount(store,source.id),0);
});

test('封口文件同长度篡改或keyframe索引篡改拒绝旧缓存，所有失败释放租约',async t=>{
  for(const kind of ['bytes','index']) {
    const fixture=await setup(t),{store,source}=fixture;
    const before=await stableSourceFingerprint(store,source,0,2);assert.ok(before);
    if(kind==='bytes') {
      const chunk=store.get('SELECT * FROM chunks WHERE source=? AND seq=0',source.id),stat=await fs.stat(chunk.path),data=await fs.readFile(chunk.path);
      data[20]^=1;await fs.writeFile(chunk.path,data);await fs.utimes(chunk.path,stat.atime,stat.mtime);
      await assert.rejects(collect(sourceStream(store,source.id,0,2)),{code:'PREP_SOURCE_STALE'});
    } else store.run('UPDATE keyframes SET offset=offset+1 WHERE source=? AND seq=0',source.id);
    await assert.rejects(stableSourceFingerprint(store,source,0,2),{code:'PREP_SOURCE_STALE'});
    assert.equal(sourceReaderCount(store,source.id),0);
  }
});

test('整理后的raw定位索引损坏不能以相同媒体身份复用缓存或读取错误关键帧',async t=>{
  const fixture=await setup(t),{store,source}=fixture;await finish(fixture);await compact(fixture);
  assert.ok(await stableSourceFingerprint(store,source,0,2));
  const keys=store.all('SELECT * FROM direct_keyframes WHERE source=? ORDER BY time',source.id);
  store.run('UPDATE direct_keyframes SET raw_offset=? WHERE source=? AND seq=? AND chunk_offset=?',keys[1].raw_offset,source.id,keys[0].seq,keys[0].chunk_offset);
  await assert.rejects(stableSourceFingerprint(store,source,0,2),{code:'PREP_SOURCE_STALE'});
  await assert.rejects(collect(sourceStream(store,source.id,0,2)),{code:'PREP_SOURCE_STALE'});
  assert.equal(sourceReaderCount(store,source.id),0);
});

test('换编码头前先封口，旧区间仍用旧头，跨epoch不可提前处理，新epoch关键帧后可独立处理',async t=>{
  const fixture=await setup(t),{store,source}=fixture;
  const oldHeader=store.get('SELECT header FROM sources WHERE id=?',source.id).header;
  const before=await stableSourceFingerprint(store,source,0,2),next=flvTag(9,8000,24,{header:true});next[16]^=1;
  await append(fixture,8,22,{header:next});
  assert.equal(await stableSourceFingerprint(store,source,0,2),before);
  const spanning=stableSourceRangeStatus(store,source,6,10);
  assert.equal(spanning.ready,false);assert.equal(spanning.codecStable,false);assert.equal(spanning.reason,'codec-change');
  const later=stableSourceRangeStatus(store,source,14,17);assert.equal(later.ready,true);
  assert.notEqual(codecHeaderSignature(later.header),codecHeaderSignature(oldHeader));
  const early=(await collect(sourceStream(store,source.id,0,2))).bytes;
  assert.equal(codecHeaderSignature({video:tags(early.subarray(13)).items[0].tag.toString('base64')}),codecHeaderSignature({video:JSON.parse(oldHeader).video}));
  const live=(await collect(sourceStream(store,source.id,0,17))).bytes;
  const boundary=(await collect(sourceStream(store,source.id,0,7.8))).bytes;
  assert.equal(tags(boundary.subarray(13)).items.filter(({tag})=>tag[0]===9&&tag[12]===0).length,1);
  const headers=tags(live.subarray(13)).items.filter(({tag})=>tag[0]===9&&tag[12]===0).map(({tag})=>timestamp(tag));
  assert.deepEqual(headers,[0,8000]);
  await finish(fixture);const changedBefore=await stableSourceFingerprint(store,source,14,17);await compact(fixture);
  assert.equal(await stableSourceFingerprint(store,source,14,17),changedBefore);
  const direct=(await collect(sourceStream(store,source.id,0,17))).bytes;
  assert.deepEqual(direct,live);
  const directHeaders=tags(direct.subarray(13)).items.filter(({tag})=>tag[0]===9&&tag[12]===0).map(({tag})=>timestamp(tag));
  assert.deepEqual(directHeaders,headers);
});

test('仅重复sequence header的时间戳变化不创建不同编码epoch，旧素材保守fallback',async t=>{
  const fixture=await setup(t),{store,source}=fixture;
  await append(fixture,8,14,{header:flvTag(9,8000,24,{header:true})});
  assert.equal(stableSourceRangeStatus(store,source,6,10).ready,true);
  store.run('DELETE FROM chunk_identities WHERE source=? AND seq=0',source.id);
  assert.equal(await stableSourceFingerprint(store,source,0,2),null);
  assert.equal(stableSourceRangeStatus(store,source,0,2).ready,false);
  assert.equal(stableSourceRangeStatus(store,source,0,2).reason,'legacy');
});

test('采集健康快照反映实际索引推进和写入耗时，空轮询不伪造进展且不暴露可变内部状态',async t=>{
  const fixture=await setup(t),{ingest,source}=fixture;
  let now=10000;ingest.now=()=>++now;
  await append(fixture,8,10);
  const progress=ingest.healthSnapshot(source.id);
  assert.ok(progress.observedAt>=10000);assert.ok(progress.lastProgressAt>=progress.lastIngestAt);
  assert.equal(progress.unreadBytes,0);assert.equal(progress.inFlightWriteSince,null);assert.ok(progress.writeLatencyMs>=1);
  progress.unreadBytes=123456;
  await ingest.tick();const idle=ingest.healthSnapshot(source.id);
  assert.equal(idle.unreadBytes,0);assert.equal(idle.lastProgressAt,progress.lastProgressAt);assert.ok(idle.lastIngestAt>progress.lastIngestAt);
  assert.equal(ingest.healthSnapshot('unknown'),null);
});
