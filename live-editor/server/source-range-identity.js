import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireReader,checkedFile,fingerprint,originalTags,isMedia,isCodecHeader} from './storage-files.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
export const mediaDigest=data=>digest(data);
export const keyframesDigest=keys=>digest(JSON.stringify(keys.map(key=>[key.time,key.offset])));
export const directKeyframesDigest=keys=>digest(JSON.stringify(keys.map(key=>[key.time,key.chunk_offset,key.raw_offset])));
export const staleSource=message=>Object.assign(new Error(message),{code:'PREP_SOURCE_STALE'});

// ACL propagation can change ctime on Windows without changing any media.
// This is only permission to verify content, never permission to trust it.
export function metadataOnlyChange(stat,saved) {
  let before;try{before=JSON.parse(saved);}catch{return false;}
  return !!before&&typeof before.ctimeNs==='string'&&before.ctimeNs!==String(stat.ctimeNs)&&
    ['dev','ino','size','mtimeNs'].every(name=>before[name]===String(stat[name]));
}

// FLV repeats sequence headers with later timestamps without changing codecs.
// Store the original header for decoding, but compare only its retimed bytes.
export function normalizedCodecHeader(value) {
  const input=typeof value==='string'?JSON.parse(value):value,result={};
  for(const name of ['video','audio'])if(input?.[name]) {
    const tag=Buffer.from(input[name],'base64');
    if(tag.length<15)throw staleSource('素材编码头不完整。');
    tag.fill(0,4,8);result[name]=tag.toString('base64');
  }
  return result;
}
export const codecHeaderSignature=value=>JSON.stringify(normalizedCodecHeader(value));

export function verifyDirectKeyframes(store,sourceId,seq) {
  const manifest=store.get('SELECT keys_hash FROM compact_chunks WHERE source=? AND seq=?',sourceId,seq);
  if(!manifest?.keys_hash) {
    if(store.get('SELECT seq FROM chunk_identities WHERE source=? AND seq=?',sourceId,seq))throw staleSource('已整理素材缺少定位索引验证记录。');
    return; // Historical direct sources retain the existing conservative path.
  }
  const mappings=store.all('SELECT time,chunk_offset,raw_offset FROM direct_keyframes WHERE source=? AND seq=? ORDER BY chunk_offset',sourceId,seq);
  if(directKeyframesDigest(mappings)!==manifest.keys_hash)throw staleSource('完整原片的定位索引发生变化，无法安全读取。');
}

function range(store,source,from,to) {
  const current=store.get('SELECT * FROM sources WHERE id=?',source.id);
  if(!current||!store.session(current.session))throw staleSource('素材不存在或已经删除。');
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return {current,reason:'range'};
  const readFrom=Math.max(current.start,from-6);
  const key=store.get('SELECT * FROM keyframes WHERE source=? AND time<=? ORDER BY time DESC LIMIT 1',current.id,readFrom)||store.get('SELECT * FROM keyframes WHERE source=? ORDER BY time LIMIT 1',current.id);
  if(!key)return {current,reason:'keyframe'};
  const chunks=store.all('SELECT chunks.*,chunk_identities.sha256,chunk_identities.fingerprint,chunk_identities.header,chunk_identities.keys_hash FROM chunks LEFT JOIN chunk_identities ON chunk_identities.source=chunks.source AND chunk_identities.seq=chunks.seq WHERE chunks.source=? AND chunks.seq>=? AND chunks.start<=? ORDER BY chunks.seq',current.id,key.seq,to+.1);
  if(!chunks.length||chunks.some((chunk,i)=>chunk.seq!==key.seq+i||!chunk.sha256))return {current,key,chunks,reason:'legacy'};
  const header=JSON.parse(chunks[0].header),signature=codecHeaderSignature(header);
  const codecStable=chunks.every(chunk=>codecHeaderSignature(chunk.header)===signature);
  // A later sealed chunk proves that the tail of this range is no longer in
  // the ingestor's mutable buffer. Closed historical inputs need no guard.
  const guarded=current.closed===2||!!store.get('SELECT seq FROM chunks WHERE source=? AND start>? LIMIT 1',current.id,to+.1);
  return {current,key,chunks,header,codecStable,ready:guarded&&codecStable&&!current.error,reason:current.error?'source-error':!codecStable?'codec-change':!guarded?'tail':''};
}

export function stableSourceRangeStatus(store,source,from,to) {
  const result=range(store,source,from,to);
  return {ready:!!result.ready,codecStable:!!result.codecStable,reason:result.reason||'',header:result.header||null,base:result.key?.time??null};
}

// Identities bind immutable sealed media, per-chunk codec headers and keyframe
// indexes. The original file's growing length/mtime and storage mode are not
// content identity. No full recording is read on this path.
export async function stableSourceFingerprint(store,source,from,to) {
  const reader=acquireReader(store,source.id);
  try {
    const result=range(store,source,from,to),{current,chunks,key}=result;
    if(!chunks?.length||result.reason==='legacy'||result.reason==='range'||result.reason==='keyframe')return null;
    let recoverDirect=false;
    if(reader.mode==='direct') {
      const stat=await checkedFile(path.join(store.root,'originals'),current.path);
      if(fingerprint(stat)!==reader.storage.fingerprint){
        if(!metadataOnlyChange(stat,reader.storage.fingerprint))throw staleSource('完整原片在整理后发生变化，无法复用预处理结果。');
        recoverDirect=true;
      }
    }
    const rows=[];
    for(const chunk of chunks) {
      const keys=store.all('SELECT time,offset FROM keyframes WHERE source=? AND seq=? ORDER BY offset',current.id,chunk.seq);
      if(keyframesDigest(keys)!==chunk.keys_hash)throw staleSource('素材关键帧索引发生变化，无法复用预处理结果。');
      if(reader.mode==='direct') {
        const manifest=store.get('SELECT sha256,fingerprint FROM compact_chunks WHERE source=? AND seq=?',current.id,chunk.seq);
        if(!manifest||manifest.sha256!==chunk.sha256||manifest.fingerprint!==chunk.fingerprint)throw staleSource('已整理素材的片段验证记录不一致。');
        verifyDirectKeyframes(store,current.id,chunk.seq);
      } else {
        const stat=await checkedFile(path.join(store.root,'chunks',current.id),chunk.path);
        if(Number(stat.size)!==chunk.bytes)throw staleSource('内部片段在封口后发生变化，无法复用预处理结果。');
        if(fingerprint(stat)!==chunk.fingerprint){
          if(!metadataOnlyChange(stat,chunk.fingerprint))throw staleSource('内部片段在封口后发生变化，无法复用预处理结果。');
          await readSealedChunk(store,chunk);
        }
      }
      rows.push([chunk.seq,chunk.start,chunk.end,chunk.bytes,chunk.sha256,codecHeaderSignature(chunk.header),chunk.keys_hash]);
    }
    if(recoverDirect)for await(const _ of verifiedDirectChunks(store,current,key.seq,chunks.at(-1).seq)){}
    return digest(JSON.stringify(['sealed-range-v1',current.id,current.start,key.time,key.seq,key.offset,rows]));
  } finally {reader.release();}
}

// Validate bytes already being read for playback/render, without another disk
// scan. Legacy chunks keep their existing read behavior until re-ingested.
export async function readSealedChunk(store,chunk) {
  const identity=store.get('SELECT * FROM chunk_identities WHERE source=? AND seq=?',chunk.source,chunk.seq);
  if(!identity)return {data:await fs.readFile(chunk.path),header:null};
  const stat=await checkedFile(path.join(store.root,'chunks',chunk.source),chunk.path);
  const observed=fingerprint(stat);
  if(observed!==identity.fingerprint&&!metadataOnlyChange(stat,identity.fingerprint))throw staleSource('内部片段在封口后发生变化。');
  const file=await fs.open(chunk.path,'r');
  try {
    if(fingerprint(await file.stat({bigint:true}))!==observed)throw staleSource('内部片段在打开时发生变化。');
    const data=await file.readFile();
    if(fingerprint(await file.stat({bigint:true}))!==observed||data.length!==chunk.bytes||mediaDigest(data)!==identity.sha256||
      fingerprint(await checkedFile(path.join(store.root,'chunks',chunk.source),chunk.path))!==observed)throw staleSource('内部片段在读取时发生变化。');
    return {data,header:JSON.parse(identity.header)};
  } finally {await file.close();}
}

// Compacted recordings no longer have physical chunks. If only ctime changed,
// reconstruct the requested chunks from the nearest earlier indexed keyframe
// and verify their original SHA-256 receipts before yielding a single byte.
// Reads remain bounded to the requested interval; no startup/full-file scan,
// index rewrite, original mutation, or file removal is involved.
export async function* verifiedDirectChunks(store,source,firstSeq,lastSeq,{signal}={}) {
  const root=path.join(store.root,'originals'),stat=await checkedFile(root,source.path),observed=fingerprint(stat);
  const storage=store.get('SELECT fingerprint FROM source_storage WHERE source=?',source.id);
  if(observed!==storage?.fingerprint&&!metadataOnlyChange(stat,storage?.fingerprint))throw staleSource('完整原片在整理后发生变化，无法安全读取，请恢复原文件。');
  const key=store.get('SELECT * FROM direct_keyframes WHERE source=? AND (seq<? OR (seq=? AND chunk_offset=0)) ORDER BY seq DESC,chunk_offset DESC LIMIT 1',source.id,firstSeq,firstSeq);
  const begin=key?.seq??0;
  const chunks=store.all('SELECT chunks.*,chunk_identities.sha256,chunk_identities.header,chunk_identities.keys_hash FROM chunks LEFT JOIN chunk_identities ON chunks.source=chunk_identities.source AND chunks.seq=chunk_identities.seq WHERE chunks.source=? AND chunks.seq>=? AND chunks.seq<=? ORDER BY chunks.seq',source.id,begin,lastSeq);
  if(!chunks.length||chunks.length!==lastSeq-begin+1||chunks.some((row,i)=>row.seq!==begin+i||!Number.isSafeInteger(row.bytes)||row.bytes<=0||row.bytes>64*1024*1024||!row.sha256||!row.header))throw staleSource('完整原片的片段验证记录不完整，无法安全读取。');
  let index=0,offset=key?.chunk_offset??0,parts=[],hash=createHash('sha256');
  if(!Number.isSafeInteger(offset)||offset<0||offset>=chunks[0].bytes)throw staleSource('完整原片的定位索引发生变化，无法安全读取。');
  const file=await fs.open(source.path,'r');
  try {
    if(fingerprint(await file.stat({bigint:true}))!==observed)throw staleSource('完整原片在打开时发生变化。');
    for await(const {tag} of originalTags(file,key?.raw_offset??13,{signal})){
      const chunk=chunks[index];
      if(!isMedia(tag))continue;
      if(isCodecHeader(tag)){
        const name=tag[0]===9?'video':'audio',saved=JSON.parse(chunk.header);
        if(codecHeaderSignature({[name]:tag.toString('base64')})!==codecHeaderSignature({[name]:saved[name]}))throw staleSource('完整原片的编码头与封口记录不一致。');
        continue;
      }
      if(offset+tag.length>chunk.bytes)throw staleSource('完整原片的数据包边界与封口记录不一致。');
      if(chunk.seq>=firstSeq){parts.push(Buffer.from(tag));hash.update(tag);}
      offset+=tag.length;
      if(offset!==chunk.bytes)continue;
      if(chunk.seq>=firstSeq){
        const keys=store.all('SELECT time,offset FROM keyframes WHERE source=? AND seq=? ORDER BY offset',source.id,chunk.seq);
        if(keyframesDigest(keys)!==chunk.keys_hash||hash.digest('hex')!==chunk.sha256)throw staleSource('完整原片的内容或关键帧索引与封口记录不一致。');
        verifyDirectKeyframes(store,source.id,chunk.seq);
        if(fingerprint(await file.stat({bigint:true}))!==observed||fingerprint(await checkedFile(root,source.path))!==observed)throw staleSource('完整原片在读取时发生变化。');
        yield {data:Buffer.concat(parts),header:JSON.parse(chunk.header),chunk};
      }
      index++;if(index===chunks.length)return;
      offset=0;parts=[];hash=createHash('sha256');
    }
    if(!signal?.aborted)throw staleSource('完整原片的内容不完整，无法安全读取。');
  } finally {await file.close();}
}
