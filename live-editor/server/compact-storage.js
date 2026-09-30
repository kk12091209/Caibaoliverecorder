import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate as immediate,setTimeout as pause} from 'node:timers/promises';
import {timestamp,tags} from './ingest.js';
import {checkedFile,fingerprint,inside,pathKey,originalTags,isMedia,isCodecHeader,isKeyframe,chunkReaderCount} from './storage-files.js';

const cancelled=()=>Object.assign(new Error('素材整理已暂停。'),{code:'COMPACT_CANCELLED'});
const digest=()=>createHash('sha256');

// Scope is intentionally limited to future recordings: eligible defaults to 0
// for every historical source. Only Recorder's new FileOpening event sets it
// to 1. No startup scan, import, recovery scan or retry grants eligibility.
// Only recordings begun with this feature can release their verified
// transient copies. Historical recordings and imported files remain intact.
export class CompactStorage {
  constructor(store,{now=Date.now,unlink=file=>fs.unlink(file),isBusy=()=>!!store.get("SELECT sources.id FROM sources JOIN sessions ON sessions.id=sources.session WHERE sources.closed=0 AND sources.error='' AND sessions.deleted_at='' AND sessions.status IN ('recording','waiting') LIMIT 1")}={}) {
    this.store=store;store.storage=this;this.now=now;this.unlink=unlink;this.isBusy=isBusy;this.busy=false;this.currentSession=null;this.closed=false;this.blocked=new Map();this.task=null;
  }
  blockSession(id){this.blocked.set(id,(this.blocked.get(id)||0)+1);return this.waitForSession(id);}
  allowSession(id){const count=this.blocked.get(id)||0;if(count>1)this.blocked.set(id,count-1);else this.blocked.delete(id);}
  async waitForSession(id){if(this.currentSession===id)await this.task;}
  async close(){this.closed=true;await this.task;}
  retry(sourceId){this.store.run("UPDATE source_storage SET status=CASE WHEN mode='direct' THEN 'pending' ELSE 'new' END,reason='',next_retry=0 WHERE source=? AND eligible=1",sourceId);}
  assertActive(source){if(this.closed||this.blocked.has(source.session)||this.store.deletions?.has(source.session)||!this.store.session(source.session))throw cancelled();}
  async cooperate(source){this.assertActive(source);await immediate();while(this.isBusy()){this.assertActive(source);await pause(50);}this.assertActive(source);}
  async tick() {
    if(this.closed||this.busy||this.isBusy())return;
    this.busy=true;this.task=this.runTick();
    try{return await this.task;}finally{this.busy=false;this.currentSession=null;this.task=null;}
  }
  async runTick() {
    const candidates=this.store.all("SELECT sources.*,source_storage.mode AS storage_mode FROM sources JOIN sessions ON sessions.id=sources.session JOIN source_storage ON source_storage.source=sources.id WHERE source_storage.eligible=1 AND sources.closed=2 AND sources.error='' AND sessions.status='finished' AND sessions.deleted_at='' AND source_storage.status IN ('new','pending') AND source_storage.next_retry<=? ORDER BY CASE WHEN source_storage.mode='direct' THEN 0 ELSE 1 END,sessions.created,sources.start",this.now());
    const source=candidates.find(row=>!this.blocked.has(row.session)&&!this.store.deletions?.has(row.session)&&(row.storage_mode!=='direct'||!chunkReaderCount(this.store,row.id)));if(!source)return;
    this.currentSession=source.session;this.referenceCache=null;
    try {
      if(source.storage_mode!=='direct')await this.verifyAndCommit(source);
      return await this.cleanup(source);
    }catch(error) {
      const current=this.store.get('SELECT mode FROM source_storage WHERE source=?',source.id);if(!current)return;
      if(error.code==='COMPACT_CANCELLED')return {source:source.id,cancelled:true};
      const direct=current.mode==='direct',reason=error.code==='ENOENT'?'完整原片或过渡片段缺失，已保留现有文件。':error.message;
      this.store.run('UPDATE source_storage SET status=?,reason=?,next_retry=?,updated=? WHERE source=?',direct?'pending':'blocked',reason,direct?this.now()+30000:0,new Date(this.now()).toISOString(),source.id);
      return {source:source.id,mode:current.mode,reason};
    }
  }
  signature(source){return JSON.stringify([source.path,source.start,source.duration,source.header,source.pos,source.closed,source.error]);}
  ownedFolder(source){if(!source.id||/[\\/\x00-\x1f]/.test(source.id)||['.','..'].includes(source.id))throw new Error('内部片段编号异常，已保留文件。');return path.join(this.store.root,'chunks',source.id);}
  revision(){return this.store.get('SELECT total_changes() AS n').n+':'+this.store.get('PRAGMA data_version').data_version;}
  ownWrite(fn){const revision=this.revision(),result=fn();if(this.referenceCache?.revision===revision)this.referenceCache.revision=this.revision();return result;}
  references(source) {
    const files=[];
    for(const item of this.store.all('SELECT path FROM chunks WHERE source<>?',source.id))files.push(item.path);
    for(const row of this.store.all('SELECT path,xml FROM sources'))files.push(row.path,row.xml);
    for(const row of this.store.all("SELECT archive FROM sessions WHERE archive!=''"))files.push(row.archive);
    for(const row of this.store.all('SELECT file,data FROM jobs')){
      let data;try{data=JSON.parse(row.data);}catch{}
      files.push(row.file,data?.output?.file,data?.output?.danmakuFile);
    }
    return [...new Set(files.filter(file=>typeof file==='string'&&path.isAbsolute(file)).map(pathKey))].sort();
  }
  async assertUnshared(source,files) {
    const revision=this.revision();let cache=this.referenceCache;
    if(!cache||cache.revision!==revision) {
      const references=this.references(source),signature=JSON.stringify(references);
      if(cache?.signature===signature)cache.revision=revision;
      else {
        const protectedPaths=new Set(references);
        for(let offset=0;offset<references.length;offset+=32) {
          await Promise.all(references.slice(offset,offset+32).map(async file=>{try{protectedPaths.add(pathKey(await fs.realpath(file)));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}}));
          await this.cooperate(source);
        }
        if(this.revision()!==revision&&JSON.stringify(this.references(source))!==signature)throw new Error('素材文件引用正在变化，请稍后重试整理。');
        cache={revision:this.revision(),signature,paths:protectedPaths};this.referenceCache=cache;
      }
    }
    for(const file of files)if(cache.paths.has(pathKey(file)))throw new Error('过渡片段仍被其他素材或已导出视频引用，已保留文件。');
  }
  async checkedChunks(source,chunks,{pending=false}={}) {
    const folder=this.ownedFolder(source),root=path.join(this.store.root,'chunks');
    const stat=await checkedFile(root,folder,{directory:true,missing:pending});
    const expected=new Set(chunks.map(chunk=>path.basename(chunk.path)));
    if(stat)for(const name of await fs.readdir(folder))if(!expected.has(name))throw new Error('过渡片段目录含额外文件，已保留整个目录。');
    await this.assertUnshared(source,chunks.map(chunk=>chunk.path));
    const result=[];
    for(const chunk of chunks) {
      const expectedPath=path.join(folder,String(chunk.seq).padStart(8,'0')+'.flvpart');
      if(pathKey(chunk.path)!==pathKey(expectedPath))throw new Error('过渡片段路径与素材索引不符，已保留文件。');
      const observed=await checkedFile(folder,chunk.path,{missing:pending});
      if(observed?.nlink>1n)throw new Error('过渡片段有共享硬链接，已保留文件。');
      result.push({...chunk,stat:observed});await this.cooperate(source);
    }
    return result;
  }
  async verifyAndCommit(source) {
    this.assertActive(source);
    if(!this.store.get('SELECT eligible FROM source_storage WHERE source=?',source.id)?.eligible)throw cancelled();
    const originals=path.join(this.store.root,'originals');
    if(!inside(originals,source.path)||!/\.flv$/i.test(source.path))throw new Error('外部导入素材不自动释放过渡片段。');
    const originalStat=await checkedFile(originals,source.path),sealed=fingerprint(originalStat),handle=await fs.open(source.path,'r');
    try {
      if(fingerprint(await handle.stat({bigint:true}))!==sealed)throw new Error('原片在打开时发生变化，已保留过渡片段。');
      const header=Buffer.alloc(13);const read=await handle.read(header,0,13,0);
      if(read.bytesRead!==13||header.toString('ascii',0,3)!=='FLV'||header.readUInt32BE(5)!==9||header.readUInt32BE(9)!==0)throw new Error('完整原片 FLV 文件头异常，已保留过渡片段。');
      const chunks=this.store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq',source.id);
      if(!chunks.length||chunks.some((row,index)=>row.seq!==index))throw new Error('内部片段索引不完整，已保留文件。');
      const entries=await this.checkedChunks(source,chunks),keys=this.store.all('SELECT * FROM keyframes WHERE source=? ORDER BY seq,offset',source.id);
      if(!keys.length)throw new Error('素材缺少关键帧索引，已保留过渡片段。');
      const keysBySeq=new Map();for(const key of keys){if(!keysBySeq.has(key.seq))keysBySeq.set(key.seq,[]);keysBySeq.get(key.seq).push(key);}
      const chunkHash=digest(),chunkKeys=[],manifest=[];let mediaOffset=0;
      for(const entry of entries) {
        const file=await fs.open(entry.path,'r');let data;
        try{if(fingerprint(await file.stat({bigint:true}))!==fingerprint(entry.stat))throw new Error('过渡片段在读取前发生变化。');data=await file.readFile();if(fingerprint(await file.stat({bigint:true}))!==fingerprint(entry.stat))throw new Error('过渡片段在读取中发生变化。');}finally{await file.close();}
        if(data.length!==entry.bytes)throw new Error('过渡片段长度与索引不符，已保留文件。');
        const parsed=tags(data);if(parsed.consumed!==data.length)throw new Error('过渡片段尾部不完整，已保留文件。');
        const actualKeys=[];
        for(const {tag,offset} of parsed.items){if(!isMedia(tag)||isCodecHeader(tag))throw new Error('过渡片段包含无法识别的数据包，已保留文件。');if(isKeyframe(tag))actualKeys.push({time:source.start+timestamp(tag)/1000,offset});}
        const expectedKeys=keysBySeq.get(entry.seq)||[];
        if(JSON.stringify(actualKeys)!==JSON.stringify(expectedKeys.map(key=>({time:key.time,offset:key.offset}))))throw new Error('过渡片段关键帧与索引不一致，已保留文件。');
        chunkKeys.push(...expectedKeys.map(key=>({...key,mediaOffset:mediaOffset+key.offset})));mediaOffset+=data.length;chunkHash.update(data);
        manifest.push({seq:entry.seq,path:entry.path,fingerprint:fingerprint(entry.stat),sha256:digest().update(data).digest('hex')});await this.cooperate(source);
      }
      const rawHash=digest(),rawKeys=[],headers={};let rawMediaOffset=0,rawBytes=13;
      for await(const {tag,offset} of originalTags(handle,13,{checkpoint:()=>this.cooperate(source)})) {
        rawBytes=offset+tag.length;
        if(!isMedia(tag))continue;
        if(tag[0]===9&&(tag[11]&15)!==7)throw new Error('原片视频编码与内部索引不符。');
        if(isCodecHeader(tag)){headers[tag[0]===9?'video':'audio']=tag.toString('base64');continue;}
        if(isKeyframe(tag))rawKeys.push({time:source.start+timestamp(tag)/1000,mediaOffset:rawMediaOffset,raw_offset:offset});
        rawHash.update(tag);rawMediaOffset+=tag.length;
      }
      const storedHeaders=JSON.parse(source.header);
      if(['video','audio'].some(name=>headers[name]!==storedHeaders[name]))throw new Error('原片编码头与已录制索引不同，已保留过渡片段。');
      if(rawMediaOffset!==mediaOffset||rawHash.digest('hex')!==chunkHash.digest('hex'))throw new Error('完整原片内容与过渡片段不一致，已保留过渡片段。');
      if(rawKeys.length!==chunkKeys.length||rawKeys.some((key,i)=>key.time!==chunkKeys[i].time||key.mediaOffset!==chunkKeys[i].mediaOffset))throw new Error('完整原片关键帧映射不一致，已保留过渡片段。');
      if(rawBytes!==Number(originalStat.size)||source.pos!==rawBytes)throw new Error('原片长度与已完成的索引位置不符，已保留过渡片段。');
      if(fingerprint(await handle.stat({bigint:true}))!==sealed||fingerprint(await checkedFile(originals,source.path))!==sealed)throw new Error('完整原片在验证期间发生变化，已保留过渡片段。');
      const again=await this.checkedChunks(source,chunks);
      if(again.some((entry,i)=>fingerprint(entry.stat)!==manifest[i].fingerprint))throw new Error('过渡片段在验证期间发生变化，已保留文件。');
      if(fingerprint(await handle.stat({bigint:true}))!==sealed||fingerprint(await checkedFile(originals,source.path))!==sealed)throw new Error('完整原片在提交前被替换或改变，已保留过渡片段。');
      this.assertActive(source);
      this.ownWrite(()=>this.store.transaction(()=>{
        const current=this.store.get('SELECT * FROM sources WHERE id=?',source.id),session=this.store.session(source.session);
        if(!session||session.status!=='finished'||!this.store.get('SELECT eligible FROM source_storage WHERE source=?',source.id)?.eligible||this.signature(current)!==this.signature(source)||JSON.stringify(this.store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq',source.id))!==JSON.stringify(chunks)||JSON.stringify(this.store.all('SELECT * FROM keyframes WHERE source=? ORDER BY seq,offset',source.id))!==JSON.stringify(keys))throw cancelled();
        this.store.run('DELETE FROM direct_keyframes WHERE source=?',source.id);this.store.run('DELETE FROM compact_chunks WHERE source=?',source.id);
        for(let i=0;i<rawKeys.length;i++)this.store.run('INSERT INTO direct_keyframes VALUES(?,?,?,?,?)',source.id,chunkKeys[i].seq,chunkKeys[i].offset,rawKeys[i].time,rawKeys[i].raw_offset);
        for(const entry of manifest)this.store.run('INSERT INTO compact_chunks(source,seq,path,fingerprint,sha256) VALUES(?,?,?,?,?)',source.id,entry.seq,entry.path,entry.fingerprint,entry.sha256);
        this.store.run("UPDATE source_storage SET mode='direct',status='pending',reason='',fingerprint=?,verified_bytes=?,next_retry=0,updated=? WHERE source=?",sealed,mediaOffset,new Date(this.now()).toISOString(),source.id);
      }));
    } finally {await handle.close();}
  }
  async cleanup(source) {
    this.assertActive(source);
    const storage=this.store.get('SELECT * FROM source_storage WHERE source=?',source.id);
    if(!storage?.eligible||storage.mode!=='direct')throw cancelled();
    if(chunkReaderCount(this.store,source.id))return {source:source.id,mode:'direct',pendingReaders:true};
    const originals=path.join(this.store.root,'originals');
    const checkOriginal=async()=>{if(fingerprint(await checkedFile(originals,source.path))!==storage.fingerprint)throw new Error('完整原片在清理前发生变化，已保留剩余过渡片段。');};
    await checkOriginal();
    const manifest=this.store.all('SELECT * FROM compact_chunks WHERE source=? ORDER BY seq',source.id),entries=await this.checkedChunks(source,manifest,{pending:true});
    for(const entry of entries) {
      this.assertActive(source);if(chunkReaderCount(this.store,source.id))return {source:source.id,mode:'direct',pendingReaders:true};
      await checkOriginal();await this.assertUnshared(source,[entry.path]);
      const stat=await checkedFile(this.ownedFolder(source),entry.path,{missing:true});
      if(stat&&fingerprint(stat)!==entry.fingerprint)throw new Error('过渡片段在清理前发生变化，已保留剩余文件。');
      if(entry.deleted){if(stat)throw new Error('已清理的片段路径出现新文件，已保留文件。');continue;}
      if(stat)await this.unlink(entry.path);
      this.ownWrite(()=>this.store.transaction(()=>{this.store.run('UPDATE compact_chunks SET deleted=1 WHERE source=? AND seq=?',source.id,entry.seq);if(stat)this.store.run('UPDATE source_storage SET freed_bytes=freed_bytes+? WHERE source=?',Number(stat.size),source.id);}));
      await this.cooperate(source);
    }
    const folder=this.ownedFolder(source);try{await checkedFile(path.join(this.store.root,'chunks'),folder,{directory:true});await fs.rmdir(folder);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
    this.store.run("UPDATE source_storage SET status='done',reason='',next_retry=0,updated=? WHERE source=?",new Date(this.now()).toISOString(),source.id);
    return {source:source.id,mode:'direct',freedBytes:this.store.get('SELECT freed_bytes FROM source_storage WHERE source=?',source.id).freed_bytes};
  }
}
