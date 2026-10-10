import { createHash } from 'node:crypto';
import { isStickerPlaceholder } from './chat-filter.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { sourceStream, seekBase } from './ingest.js';
import { preparedEncoderArguments, videoGeometryFilter, detectExportEncoder, softwareEncoder, canCopyFullSource } from './export-encoding.js';
import { clipFile } from './output-names.js';
import { savedDanmakuStyle, normalizedDanmakuStyle, danmakuGeometry, danmakuDuration } from '../shared/danmaku-style.js';
import { scrollingTracks, scrollingTrackEvents } from '../shared/danmaku-tracks.js';
import {chatRate,validateChatRate} from './chat-rules.js';

export const RENDER_VERSION = 6;
export const hashRender = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function eligibleComments(messages, rate) {
  let second = -Infinity, count = 0;
  return messages.filter(m => m.type === 'd' && Number.isFinite(m.time) && !m.policyFiltered && !isStickerPlaceholder(m.text))
    .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter(message => { const current = Math.floor(message.time); if (current !== second) { second = current; count = 0; } return count++ < rate; });
}

export function layoutComments(messages, { rate = 50, width = 1280, height = 720, style, font } = {}) {
  return scrollingTracks(eligibleComments(messages, rate), { width, height, ...danmakuGeometry(height, style), duration: danmakuDuration(style), font });
}

// Long recordings may contain hundreds of thousands of comments. Yield between
// bounded batches so dense layout cannot block recording, cleanup or cancellation.
export async function layoutCommentsAsync(messages, { rate = 50, width = 1280, height = 720, style, font, signal } = {}) {
  canceled(signal);
  const result = [], events = scrollingTrackEvents(eligibleComments(messages, rate), { width, height, ...danmakuGeometry(height, style), duration: danmakuDuration(style), font });
  for (const event of events) {
    result.push(event);
    if (result.length % 512 === 0) { await yieldTurn(); canceled(signal); }
  }
  canceled(signal);
  return result;
}

export function visibleComments(layout, snapshot, from, to) {
  const excluded = snapshot.excluded instanceof Set ? snapshot.excluded : new Set(snapshot.excluded || []);
  return layout.filter(m => m.time < to && (m.end ?? m.time + 6) > from && !excluded.has(m.id) &&
    (snapshot.filterLottery === false || !m.lottery));
}

export function renderBlocks(sources, seconds = 60, fps = 60) {
  const result = [];
  for (const source of sources) {
    const start = Math.round(source.start * 1000), end = Math.round((source.start + source.duration) * 1000);
    for (let from = start; from < end; from += seconds * 1000) {
      const to = Math.min(end, from + seconds * 1000);
      // Keep existing cache boundaries. A rounded zero-frame tail contributes
      // no output frames and must not become an impossible encoding task.
      if (frameSpan(from / 1000, to / 1000, fps).frames) result.push({ source, startMs: from, endMs: to });
    }
  }
  return result;
}

export function exportSegments(sources, ranges, scope) {
  const segments = [];
  for (const range of ranges) {
    let cursor = range.start;
    for (const source of sources.filter(s => s.start < range.end && s.start + s.duration > range.start)) {
      const from = Math.max(cursor, source.start), to = Math.min(range.end, source.start + source.duration);
      if (to <= from) continue;
      if (from - cursor > .15 && scope !== 'full') throw new Error('选段跨越直播断流空缺，请分别添加空缺前后的选段，避免伪造缺失画面。');
      segments.push({ source, from, to }); cursor = to;
    }
    if (range.end - cursor > .15) throw new Error('选段末尾尚未完整写入，请稍后重新导出。');
  }
  return segments;
}

export function splitForCache(segment, blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.source.id !== segment.source.id) continue;
    const from = Math.max(segment.from, block.startMs / 1000), to = Math.min(segment.to, block.endMs / 1000);
    if (to <= from) continue;
    result.push({ ...block, from, to, complete: Math.abs(from * 1000 - block.startMs) < .001 && Math.abs(to * 1000 - block.endMs) < .001 });
  }
  return result;
}

export function frameSpan(from, to, fps = 60) {
  const start = Math.round(from * fps), end = Math.round(to * fps);
  return { from: start / fps, to: end / fps, frames: Math.max(0, end - start), duration: Math.max(0, end - start) / fps };
}

export function balancedSpans(from,to,fps=60) {
  const span=frameSpan(from,to,fps);if(!span.frames)return [];
  const count=Math.max(span.duration>=60?2:1,Math.ceil(span.duration/60)),first=Math.round(span.from*fps);
  return Array.from({length:count},(_,index)=>({
    from:(first+Math.round(span.frames*index/count))/fps,
    to:(first+Math.round(span.frames*(index+1)/count))/fps
  }));
}

export function commentSignature(events) {
  return hashRender(events.map(m => [m.id, m.time, m.text, m.lane, m.y, m.textWidth, m.speed, m.entryDelay, m.color]));
}

function canceled(signal) {
  if(signal?.aborted)throw Object.assign(new Error('后台预处理已暂停。'),{name:'AbortError',code:'PREP_CANCELLED'});
}
const concatPath = file => path.resolve(file).replace(/\\/g,'/').replace(/'/g,"'\\''");

export class RenderPipeline {
  constructor(media, assText, {blockSeconds=60}={}) {
    this.media=media;this.store=media.store;this.assText=assText;this.blockSeconds=blockSeconds;
    this.layouts=new Map();this.encodedInfo=new Map();this.operations=new Set();
  }
  invalidate(id){this.layouts.delete(id);}
  async layout(id,signal,rate=chatRate(this.store),geometry={}) {
    validateChatRate(rate);
    await this.store.chatRules?.prepare(id);
    const stamp=this.store.get(`SELECT COALESCE(MAX(rowid),0) AS last,COUNT(*) AS count FROM danmaku WHERE session=?`,id);
    const flags=this.store.get(`SELECT COUNT(*) AS count,COALESCE(MAX(f.rowid),0) AS last FROM danmaku_filters f JOIN danmaku d ON d.id=f.message WHERE d.session=?`,id);
    const signature=JSON.stringify([stamp,flags,rate,geometry]),cached=this.layouts.get(id);
    if(cached?.signature===signature)return cached.messages;
    const rows=[];let cursor=0;
    while(cursor<stamp.last) {
      canceled(signal);
      const batch=this.store.all(`SELECT d.rowid AS rowid,d.*,EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason='lottery') AS lottery,
        EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason IN ('length','repeat')) AS policyFiltered
        FROM danmaku d WHERE d.session=? AND d.rowid>? AND d.rowid<=? ORDER BY d.rowid LIMIT 2048`,id,cursor,stamp.last);
      if(!batch.length)break;
      rows.push(...batch);cursor=batch.at(-1).rowid;await yieldTurn();
    }
    canceled(signal);
    const messages=await layoutCommentsAsync(rows,{rate,...geometry,signal});this.layouts.delete(id);this.layouts.set(id,{signature,messages});
    while(this.layouts.size>2)this.layouts.delete(this.layouts.keys().next().value);
    return messages;
  }
  async encoder(options={}) {
    const m=this.media;
    if(!m.exportEncoder)m.exportEncoder=m.exportAcceleration==='software'?Promise.resolve(softwareEncoder()):detectExportEncoder((args,extra)=>m.process(args,{...extra,background:options.background,signal:options.signal?AbortSignal.any([options.signal,extra.signal]):extra.signal}));
    const encoder=await m.exportEncoder;
    if(options.signal?.aborted){m.exportEncoder=null;canceled(options.signal);}
    return encoder;
  }
  async describe(id,snapshot,encoder,options={}) {
    const session=this.store.session(id),sources=this.store.sources(id);
    this.media.assertFullReady(session,sources);canceled(options.signal);
    const info=await this.media.probeSource(sources[0],sources[0].start,options);
    const width=Math.max(2,Math.floor(info.width/2)*2),height=Math.max(2,Math.floor(info.height/2)*2);
    const selected=encoder||await this.encoder(options);
    const selectedFont=Object.hasOwn(snapshot,'font')?snapshot.font:this.media.fonts.selected();
    const font=selectedFont?.id?await this.media.fonts.selection(selectedFont.id):selectedFont;
    // Queued jobs own their style. Older jobs keep the previous default;
    // background preparation follows the current settings.
    const danmakuStyle=(Object.hasOwn(snapshot,'danmakuStyle')||Object.hasOwn(snapshot,'mode'))?normalizedDanmakuStyle(snapshot.danmakuStyle):savedDanmakuStyle(this.store);
    const danmakuPerSecond=validateChatRate(snapshot.danmakuPerSecond??chatRate(this.store));
    const profile={font:font?.id||null,danmakuStyle,danmakuPerSecond,version:RENDER_VERSION,width,height,fps:danmakuStyle.fps,encoder:selected,arguments:preparedEncoderArguments(selected)};
    return {id,session,sources,info,font,profile,profileHash:hashRender(profile),layout:await this.layout(id,options.signal,danmakuPerSecond,{width,height,style:danmakuStyle,font}),snapshot:{excluded:new Set(snapshot.excluded||[]),filterLottery:snapshot.filterLottery!==false},blocks:renderBlocks(sources,this.blockSeconds,danmakuStyle.fps)};
  }
  async sourceFingerprint(source,from,to) {
    const current=this.store.get('SELECT * FROM sources WHERE id=?',source.id);
    if(!current||!this.store.session(source.session))throw new Error('素材已删除。');
    const storage=this.store.get('SELECT mode,fingerprint FROM source_storage WHERE source=?',source.id);
    const metadata=[current.id,current.start,current.duration,current.closed,current.pos,current.header,storage?.mode||'chunks'];
    const fields=stat=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key]));
    if(storage?.mode==='direct') {
      const stat=await fs.lstat(current.path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw new Error('原片类型发生变化。');
      return hashRender([metadata,current.path,storage.fingerprint,fields(stat)]);
    }
    const first=this.store.get('SELECT seq FROM keyframes WHERE source=? AND time<=? ORDER BY time DESC LIMIT 1',source.id,Math.max(source.start,from-6))||this.store.get('SELECT seq FROM keyframes WHERE source=? ORDER BY time LIMIT 1',source.id);
    if(!first)throw new Error('正在等待可解码关键帧。');
    const rows=this.store.all('SELECT seq,path,bytes FROM chunks WHERE source=? AND seq>=? AND start<=? ORDER BY seq',source.id,first.seq,to+.1);
    const files=[];
    for(const row of rows) {
      const stat=await fs.lstat(row.path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw new Error('内部片段类型发生变化。');
      files.push([row.seq,row.path,row.bytes,fields(stat)]);
    }
    return hashRender([metadata,files]);
  }
  async spec(plan,block) {
    const span=frameSpan(block.startMs/1000,block.endMs/1000,plan.profile?.fps);
    const events=visibleComments(plan.layout,plan.snapshot,span.from,span.to);
    return {sessionId:plan.id,sourceId:block.source.id,startMs:block.startMs,endMs:block.endMs,
      sourceFingerprint:await this.sourceFingerprint(block.source,span.from,span.to),profileHash:plan.profileHash,assHash:commentSignature(events),version:1};
  }
  async inspect(file,options={}) {
    const previous=this.encodedInfo.get(file);if(previous)return previous;
    const info=await this.media.probe(file,options);
    this.encodedInfo.set(file,info);while(this.encodedInfo.size>512)this.encodedInfo.delete(this.encodedInfo.keys().next().value);
    return info;
  }
  async renderVideo(plan,source,from,to,file,options={}) {
    const m=this.media,span=frameSpan(from,to,plan.profile?.fps);if(!span.frames)throw new Error('选段不足一帧。');
    const readFrom=Math.max(source.start,span.from-6),base=seekBase(this.store,source.id,readFrom);
    if(base===undefined)throw new Error('正在等待可解码关键帧。');
    const workDir=await m.temporaryDirectory('bili-export-',plan.id);
    try {
      canceled(options.signal);
      const events=visibleComments(plan.layout,plan.snapshot,span.from,span.to);
      await fs.writeFile(path.join(workDir,'part-0.ass'),this.assText(events,plan.profile.width,plan.profile.height,plan.font,plan.profile.danmakuStyle));
      const fontDirectory=await m.fonts.stage(plan.font,workDir);
      const sourceInfo=source.id===plan.sources[0].id?plan.info:await m.probeSource(source,readFrom,options);
      const geometry=videoGeometryFilter(sourceInfo,plan.profile.width,plan.profile.height);
      const chain=[`setpts=PTS+${base}/TB`,geometry,'format=yuv420p','tpad=stop_mode=clone:stop_duration=0.1',`fps=fps=${plan.profile.fps}:start_time=${span.from}:round=near`,`ass=part-0.ass${fontDirectory?':fontsdir='+fontDirectory:''}`,`trim=start=${span.from}:end=${span.to}`,'setpts=PTS-STARTPTS'].filter(Boolean).join(',');
      await m.process(['-copyts','-fflags','+genpts','-threads','2','-f','flv','-i','pipe:0','-map','0:v:0','-an','-filter_threads','2','-vf',chain,
        ...plan.profile.arguments,'-frames:v',String(span.frames),'-r',String(plan.profile.fps),'-movflags','+faststart','-y',file],
      {cwd:workDir,input:sourceStream(this.store,source.id,readFrom,span.to,{signal:options.signal}),signal:options.signal,background:options.background});
      canceled(options.signal);
      const info=await m.probe(file,options);
      if(info.codec!=='h264'||info.audioStreams!==0||info.frames!==span.frames||!info.encodingSignature)throw new Error('预处理视频的帧数或编码信息不完整。');
      this.encodedInfo.set(file,info);
      return info;
    }finally{await m.temporaryWorkspaces.finish(workDir);}
  }
  async acquire(plan,block,options={}) {
    const spec=await this.spec(plan,block),cache=this.media.renderCache,span=frameSpan(block.startMs/1000,block.endMs/1000,plan.profile?.fps);
    let lease=await cache.acquire(spec);if(lease)return lease;
    lease=await cache.build(spec,async(file,{signal}={})=>this.renderVideo(plan,block.source,block.startMs/1000,block.endMs/1000,file,{...options,signal:signal||options.signal}),
      {signal:options.signal,estimatedBytes:Math.ceil((block.endMs-block.startMs)/1000*2*1024*1024),verifySource:async()=>await this.sourceFingerprint(block.source,span.from,span.to)===spec.sourceFingerprint});
    return lease;
  }
  async prepareNext(id,{signal,onProgress}={}) {
    const operation={sessionId:id},leases=[];this.operations.add(operation);
    try {
      const plan=await this.describe(id,this.store.edit(id),null,{signal,background:true});
      let preparedSeconds=0,bytes=0,missing=null;
      const seconds=block=>frameSpan(block.startMs/1000,block.endMs/1000,plan.profile?.fps).duration;
      const totalSeconds=plan.blocks.reduce((sum,b)=>sum+seconds(b),0);
      for(const block of plan.blocks) {
        canceled(signal);const lease=await this.media.renderCache.acquire(await this.spec(plan,block));
        if(lease){leases.push(lease);preparedSeconds+=seconds(block);bytes+=lease.bytes;}
        else missing??=block;
      }
      onProgress?.({preparedSeconds,totalSeconds,bytes});
      if(missing) {
        const lease=await this.acquire(plan,missing,{signal,background:true});
        leases.push(lease);preparedSeconds+=seconds(missing);bytes+=lease.bytes;
        onProgress?.({preparedSeconds,totalSeconds,bytes});
      }
      return {done:preparedSeconds>=totalSeconds-.001,preparedSeconds,totalSeconds,bytes};
    }finally{try{for(const lease of leases)await lease.release();}finally{this.operations.delete(operation);}}
  }
  async foregroundParts(plan,segments,leases) {
    const result=[];
    for(const segment of segments) {
      const partition=splitForCache(segment,plan.blocks);let hits=0;
      for(const part of partition) {
        if(!part.complete||!frameSpan(part.from,part.to,plan.profile?.fps).frames)continue;
        const lease=await this.media.renderCache.acquire(await this.spec(plan,part));
        if(lease){leases.push(lease);part.file=lease.file;part.cached=true;hits++;}
      }
      // A completely cold interval can be balanced without disturbing the
      // canonical boundaries of any existing sixty-second cache blocks.
      result.push(...(hits?partition:balancedSpans(segment.from,segment.to,plan.profile?.fps).map(span=>({...span,source:segment.source}))));
    }
    return result.filter(part=>frameSpan(part.from,part.to,plan.profile?.fps).frames>0);
  }
  async renderForegroundParts(plan,parts,workDir,{onProgress}={}) {
    const prepared=parts.map((part,index)=>({...part,file:part.file||path.join(workDir,`part-${index}.mp4`),duration:frameSpan(part.from,part.to,plan.profile?.fps).duration}));
    const missing=prepared.filter(part=>!part.cached),cachedDuration=prepared.filter(part=>part.cached).reduce((sum,part)=>sum+part.duration,0);
    const parallel=plan.profile.encoder.hardware&&missing.length>1;let reported=0;
    const progress=value=>{reported=Math.max(reported,value);onProgress?.(reported);};
    const attempt=async concurrency=>{
      const controller=new AbortController();let cursor=0,completed=cachedDuration,firstError;
      progress(completed);
      const worker=async()=>{
        while(!controller.signal.aborted) {
          try {
            if(this.media.closed)throw new Error('视频服务已关闭。');
            const part=missing[cursor++];if(!part)return;
            await this.renderVideo(plan,part.source,part.from,part.to,part.file,{signal:controller.signal});
            canceled(controller.signal);completed+=part.duration;progress(completed);
          }catch(error){firstError??=error;controller.abort();throw error;}
        }
      };
      const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,Math.max(1,missing.length))},worker));
      const failed=firstError||results.find(result=>result.status==='rejected')?.reason;
      if(failed)throw failed;
      let signature;
      for(const part of prepared) {
        if(this.media.closed)throw new Error('视频服务已关闭。');
        const info=await this.inspect(part.file);
        if(!info.encodingSignature||signature&&signature!==info.encodingSignature)throw Object.assign(new Error('缓存视频编码参数不同，将使用常规导出。'),{code:'PREP_INCOMPATIBLE'});
        signature=info.encodingSignature;
      }
      return prepared.map(({file,duration})=>({file,duration}));
    };
    try{return {files:await attempt(parallel?2:1),reused:prepared.length-missing.length};}
    catch(error) {
      this.media.assertExportActive?.();
      if(this.media.closed||!parallel||error.code==='PREP_INCOMPATIBLE')throw error;
      // The first attempt has fully settled, including aborted siblings. A
      // device with only one available encoding session may still work serially.
      try{return {files:await attempt(1),reused:prepared.length-missing.length,serialRetry:true};}
      catch(retry){if(!this.media.closed&&retry.code!=='PREP_INCOMPATIBLE')retry.hardwareEncoderFailure=true;throw retry;}
    }
  }
  async audio(segments,plan,workDir,job) {
    const infos=await Promise.all(segments.map(({source,from})=>source.id===plan.sources[0].id?plan.info:this.media.probeSource(source,from)));
    if(infos.every(info=>info.audioStreams===0))return null;
    const single=segments[0],base=seekBase(this.store,single.source.id,single.from);
    if(infos[0].audioCodec==='aac'&&canCopyFullSource(job,plan.sources,infos[0],base)) {
      await this.media.process(['-copyts','-f','flv','-i','pipe:0','-map','0:a:0','-vn','-c:a','copy','-movflags','+faststart','-y','audio.m4a'],
        {cwd:workDir,input:sourceStream(this.store,single.source.id,single.from,single.to)});
      return 'audio.m4a';
    }
    const files=[];
    for(let i=0;i<segments.length;i++) {
      const {source,from,to}=segments[i],span=frameSpan(from,to,plan.profile?.fps),name=`audio-${i}.flac`;
      if(!span.frames)continue;
      const samples=Math.round(span.duration*48000);
      if(infos[i].audioStreams===0) {
        await this.media.process(['-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',String(span.duration),'-c:a','flac','-compression_level','0','-y',name],{cwd:workDir});
      } else {
        const base=seekBase(this.store,source.id,Math.max(source.start,span.from));
        const filter=`aresample=48000:async=1:first_pts=0,atrim=start=${Math.max(0,span.from-base)}:end=${span.to-base},asetpts=PTS-STARTPTS,apad=whole_len=${samples},atrim=end_sample=${samples}`;
        await this.media.process(['-copyts','-threads','2','-f','flv','-i','pipe:0','-map','0:a:0','-vn','-af',filter,'-ar','48000','-ac','2','-c:a','flac','-compression_level','0','-y',name],
          {cwd:workDir,input:sourceStream(this.store,source.id,Math.max(source.start,span.from),span.to)});
      }
      files.push(name);
    }
    await fs.writeFile(path.join(workDir,'audio-concat.txt'),files.map(name=>`file '${name}'`).join('\n'));
    await this.media.process(['-f','concat','-safe','1','-i','audio-concat.txt','-vn','-c:a','aac','-b:a','192k','-movflags','+faststart','-y','audio.m4a'],{cwd:workDir});
    return 'audio.m4a';
  }
  async cleanVideos(segments,plan,encoder,workDir,job) {
    const files=[];
    for(let i=0;i<segments.length;i++) {
      const {source,from,to}=segments[i],span=frameSpan(from,to,plan.profile?.fps),base=seekBase(this.store,source.id,from),name=`part-${i}-danmaku.mp4`;
      const info=source.id===plan.sources[0].id?plan.info:await this.media.probeSource(source,from);
      if(canCopyFullSource(job,plan.sources,info,base)) {
        await this.media.process(['-copyts','-f','flv','-i','pipe:0','-map','0:v:0','-an','-c:v','copy','-movflags','+faststart','-y',name],
          {cwd:workDir,input:sourceStream(this.store,source.id,from,to)});
        files.push({file:path.join(workDir,name),duration:span.duration});continue;
      }
      const geometry=videoGeometryFilter(info,plan.profile.width,plan.profile.height);
      await this.media.process(['-copyts','-threads','2','-f','flv','-i','pipe:0','-ss',String(Math.max(0,span.from-base)),'-t',String(span.duration),'-map','0:v:0','-an',
        ...(geometry?['-vf',geometry]:[]),...preparedEncoderArguments(encoder),'-r',String(plan.info.fps),'-movflags','+faststart','-y',name],
        {cwd:workDir,input:sourceStream(this.store,source.id,from,to)});
      files.push({file:path.join(workDir,name),duration:span.duration});
    }
    return files;
  }
  async mux(files,audio,name,workDir,listName) {
    const videoInput=files.length===1?['-i',files[0].file]:['-f','concat','-safe','0','-i',listName];
    if(files.length>1)await fs.writeFile(path.join(workDir,listName),'ffconcat version 1.0\n'+files.map(item=>`file '${concatPath(item.file)}'\nduration ${item.duration}`).join('\n'));
    const duration=files.reduce((sum,item)=>sum+item.duration,0);
    await this.media.process(['-copyts',...videoInput,...(audio?['-i',audio]:[]),'-map','0:v:0',...(audio?['-map','1:a:0']:['-an']),'-c','copy','-t',String(duration),'-movflags','+faststart','-y',name],{cwd:workDir});
  }
  async exportJob(job,encoder) {
    const m=this.media,plan=await this.describe(job.session,job,encoder),segments=exportSegments(plan.sources,job.ranges,job.scope);
    const workDir=await m.temporaryDirectory('bili-export-',job.session),leases=[];
    try {
      const total=segments.reduce((sum,item)=>sum+frameSpan(item.from,item.to,plan.profile?.fps).duration,0);
      const parts=await this.foregroundParts(plan,segments,leases);
      if(!parts.length)throw new Error('选段中没有完整视频帧。');
      const {files,reused,serialRetry}=await this.renderForegroundParts(plan,parts,workDir,{onProgress:processed=>
        this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.8,.05+.75*processed/total),job.id)});
      if(serialRetry)job.parallelRenderFallback=true;
      if(!files.length)throw new Error('选段中没有完整视频帧。');
      const audio=await this.audio(segments,plan,workDir,job),dual=job.mode==='dual';
      this.store.run('UPDATE jobs SET progress=.85 WHERE id=?',job.id);
      const bakedName=dual?'final-danmaku.mp4':'final.mp4';
      await this.mux(files,audio,bakedName,workDir,'video-concat-danmaku.txt');
      if(dual)await this.mux(await this.cleanVideos(segments,plan,encoder,workDir,job),audio,'final.mp4',workDir,'video-concat.txt');
      this.store.run("UPDATE jobs SET status='finalizing',progress=.95 WHERE id=?",job.id);
      const results=dual?[{temporary:'final.mp4',file:job.output.file},{temporary:'final-danmaku.mp4',file:clipFile(job.output.file,'danmaku')}]:[{temporary:'final.mp4',file:clipFile(job.output.file,'danmaku')}];
      job.output.danmakuFile=clipFile(job.output.file,'danmaku');job.preparedBlocks=reused;
      m.assertExportActive?.();
      this.store.run("UPDATE jobs SET status='saving',progress=.98 WHERE id=?",job.id);
      job.pendingPublication=await m.publication.stage(job,workDir,results);job.canRetrySave=true;
      try{this.store.run("UPDATE jobs SET status='saving',progress=.98,data=? WHERE id=?",JSON.stringify(job),job.id);return await m.publishEncoded(job,workDir);}
      catch(error){error.savePending=true;throw error;}
    }finally {
      for(const lease of leases)await lease.release();
      await m.temporaryWorkspaces.finish(workDir);
    }
  }
}
