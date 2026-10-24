import { createHash } from 'node:crypto';
import { isStickerPlaceholder } from './chat-filter.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { sourceStream, seekBase } from './ingest.js';
import {exportSegments,sourceExportPlan,copyOriginal} from './export-plan.js';
import {copyFullAudio,audioSourceStream} from './export-audio.js';
import {cachedVideoIndex,splitCachedVideo} from './cached-video-slice.js';
import {videoReadStart,sequenceEligible,renderRendezvous} from './render-sequence.js';
import {mediaFailure} from './media-retry.js';
export {exportSegments} from './export-plan.js';
import { preparedEncoderArguments, checkpointEncoderArguments, videoGeometryFilter, detectExportEncoder, softwareEncoder, canCopyFullSource } from './export-encoding.js';
import { clipFile } from './output-names.js';
import { savedDanmakuStyle, normalizedDanmakuStyle, danmakuGeometry, danmakuDuration } from '../shared/danmaku-style.js';
import { linkmicAss } from './linkmic.js';
import { avatarFilter } from './linkmic-avatars.js';
import { scrollingTracks, scrollingTrackEvents } from '../shared/danmaku-tracks.js';
import {chatRate,validateChatRate} from './chat-rules.js';
import { stableSourceFingerprint, stableSourceRangeStatus, codecHeaderSignature } from './source-range-identity.js';
import { liveRenderBlocks, liveMetadataReady, blockLinkmicEvents, liveLayoutWithinBudget } from './render-live-state.js';

export const RENDER_VERSION = 9;
export const CPU_EXPORT_ROUTE = 'cpu-chunks-v1';
export const CPU_CHECKPOINT_SECONDS = 60;
export const hashRender = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function eligibleComments(messages, rate, state = {}) {
  let second = state.second ?? -Infinity, count = state.count ?? 0;
  return messages.filter(m => m.type === 'd' && Number.isFinite(m.time) && !m.policyFiltered && !isStickerPlaceholder(m.text))
    .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter(message => {
      const current = Math.floor(message.time); if (current !== second) { second = current; count = 0; }
      const admitted = count++ < rate;
      Object.assign(state, { second, count, lastInput: { time: message.time, id: String(message.id) } });
      return admitted;
    });
}

export function layoutComments(messages, { rate = 50, width = 1280, height = 720, style, font } = {}) {
  const eligible=eligibleComments(messages,rate);
  return scrollingTracks(eligible, { width, height, ...danmakuGeometry(height, style), duration: danmakuDuration(style), font, ordered: eligible.every(m=>typeof m.id==='string') });
}

// Long recordings may contain hundreds of thousands of comments. Yield between
// bounded batches so dense layout cannot block recording, cleanup or cancellation.
export async function layoutCommentsAsync(messages, { rate = 50, width = 1280, height = 720, style, font, signal, state = {} } = {}) {
  canceled(signal);
  const eligible=eligibleComments(messages,rate,state);
  const result = [], events = scrollingTrackEvents(eligible, { width, height, ...danmakuGeometry(height, style), duration: danmakuDuration(style), font, ordered: eligible.every(m=>typeof m.id==='string'), state });
  for (const event of events) {
    result.push(event);
    if (result.length % 512 === 0) { await yieldTurn(); canceled(signal); }
  }
  canceled(signal);
  return result;
}

const intervalIndexes = new WeakMap();
function commentIndex(layout) {
  let index = intervalIndexes.get(layout);
  if (!index) {
    // Layouts are immutable. Prefix maxima cover variable comment lifetimes.
    const ends = new Float64Array(layout.length); let end = -Infinity, sorted = true;
    for (let i = 0; i < layout.length; i++) {
      if (i && layout[i].time < layout[i-1].time) sorted = false;
      ends[i] = end = Math.max(end, layout[i].end ?? layout[i].time + 6);
    }
    index = { ends, sorted }; intervalIndexes.set(layout, index);
  }
  return index;
}
export function visibleComments(layout, snapshot, from, to) {
  const excluded = snapshot.excluded instanceof Set ? snapshot.excluded : new Set(snapshot.excluded || []);
  const index = commentIndex(layout); let low = 0, high = layout.length;
  if (index.sorted) while (low < high) { const mid = (low + high) >>> 1; if (index.ends[mid] <= from) low = mid + 1; else high = mid; }
  const result = [];
  for (let i = index.sorted ? low : 0; i < layout.length; i++) {
    const m = layout[i]; if (index.sorted && m.time >= to) break;
    if (m.time < to && (m.end ?? m.time + 6) > from && !excluded.has(m.id) && (snapshot.filterLottery === false || !m.lottery)) result.push(m);
  }
  return result;
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

export function checkpointSpans(from,to,fps=60) {
  const span=frameSpan(from,to,fps),first=Math.round(span.from*fps),step=Math.max(1,Math.floor(CPU_CHECKPOINT_SECONDS*fps)),result=[];
  for(let frame=first;frame<first+span.frames;frame+=step)
    result.push({from:frame/fps,to:Math.min(first+span.frames,frame+step)/fps});
  return result;
}

export function cleanCheckpointParts(segments,audioFps,fps) {
  let audioFrames=0,frames=0;
  return segments.flatMap(segment=>{
    audioFrames+=frameSpan(segment.from,segment.to,audioFps).frames;
    const end=Math.round(audioFrames*fps/audioFps),from=Math.round(segment.from*fps)/fps;
    const parts=checkpointSpans(from,from+(end-frames)/fps,fps);frames=end;
    // Distribute sub-frame rounding on the output clock, not once per source
    // or clip. Any last held frame comes from inside the selected interval.
    return parts.map(part=>({...part,source:segment.source,readTo:Math.min(part.to,segment.to)}));
  });
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
    this.layouts=new Map();this.encodedInfo=new Map();this.operations=new Set();this.preparationPlans=new Map();this.sliceIndexes=new Map();
  }
  invalidate(id){this.layouts.delete(id);this.preparationPlans.delete(id);this.media.idlePolicy?.reset(id);}
  async layout(id,signal,rate=chatRate(this.store),geometry={}) {
    validateChatRate(rate);
    await this.store.chatRules?.prepare(id);
    const stamp=this.store.get(`SELECT COALESCE(MAX(rowid),0) AS last,COUNT(*) AS count FROM danmaku WHERE session=?`,id);
    const revision=this.store.layoutRevision, external=this.store.get('PRAGMA data_version').data_version;
    const signature=JSON.stringify([revision,external,rate,geometry]),cached=this.layouts.get(id);
    const append=revision!==undefined&&cached?.signature===signature&&stamp.last>=cached.stamp.last&&stamp.count>=cached.stamp.count;
    if(append&&stamp.last===cached.stamp.last&&stamp.count===cached.stamp.count)return cached.messages;
    const readRows=async(from)=>{
    const rows=[];let cursor=from;
    while(cursor<stamp.last) {
      canceled(signal);
      const batch=this.store.all(`SELECT d.rowid AS rowid,d.*,EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason='lottery') AS lottery,
        EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason IN ('length','repeat')) AS policyFiltered
        FROM danmaku d WHERE d.session=? AND d.rowid>? AND d.rowid<=? ORDER BY d.rowid LIMIT 2048`,id,cursor,stamp.last);
      if(!batch.length)break;
      rows.push(...batch);cursor=batch.at(-1).rowid;await yieldTurn();
    }
    return rows;
    };
    let rows=await readRows(append?cached.stamp.last:0), incremental=append;
    const last=cached?.state.lastInput;
    // A late insertion (including an earlier ID at the same timestamp) can
    // change every later lane. Preserve correctness with a full rebuild.
    if(incremental&&(rows.length!==stamp.count-cached.stamp.count||rows.some(m=>m.type==='d'&&Number.isFinite(m.time)&&!m.policyFiltered&&!isStickerPlaceholder(m.text)&&last&&(m.time<last.time||(m.time===last.time&&String(m.id)<=last.id))))){
      rows=await readRows(0);incremental=false;
    }
    const state=incremental?{...cached.state,active:cached.state.active.slice(),rowUses:cached.state.rowUses.slice()}:{};
    const added=await layoutCommentsAsync(rows,{rate,...geometry,signal,state});
    canceled(signal);
    if(revision!==this.store.layoutRevision||external!==this.store.get('PRAGMA data_version').data_version)throw Object.assign(new Error('弹幕规则已更新，请重试。'),{code:'PREP_STALE'});
    const messages=incremental?cached.messages.concat(added):added;
    this.lastLayoutWork={incremental,readRows:rows.length,laidOut:added.length,total:messages.length};
    this.layouts.delete(id);this.layouts.set(id,{signature,messages,stamp,state});
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
    const live=options.live?(typeof options.live==='object'?options.live:{}):null;
    if(!live)this.media.assertFullReady(session,sources);
    else if(!session||!sources.length||sources.some(source=>source.error))return {waiting:'metadata',live:true,blocks:[]};
    canceled(options.signal);
    if(live&&!liveLayoutWithinBudget(this.store,id))return {waiting:'layout-budget',retryAfterMs:30000,live:true,blocks:[]};
    const allBlocks=renderBlocks(sources,this.blockSeconds,savedDanmakuStyle(this.store).fps);
    let liveSelection;
    if(live){
      // The first implementation defers any source with multiple codec epochs
      // to the closed-recording path; cached metadata cannot certify it live.
      for(const source of sources){
        const headers=this.store.all('SELECT DISTINCT header FROM chunk_identities WHERE source=?',source.id);
        if(new Set(headers.map(row=>codecHeaderSignature(row.header))).size>1)return {waiting:'codec',live:true,blocks:[],allBlocks};
      }
      liveSelection=liveRenderBlocks(sources,allBlocks,{...live,blockSeconds:this.blockSeconds,rangeStatus:(source,from,to)=>{const span=frameSpan(from,to,savedDanmakuStyle(this.store).fps);return stableSourceRangeStatus(this.store,source,span.from,span.to);}});
      if(!liveSelection.blocks.length)return {...liveSelection,live:true,allBlocks};
    }
    const info=await this.media.probeSource(sources[0],sources[0].start,{...options,...(live?{fresh:true}:{})});
    const width=Math.max(2,Math.floor(info.width/2)*2),height=Math.max(2,Math.floor(info.height/2)*2);
    const selected=encoder||await this.encoder(options);
    if(live&&(!selected.hardware||!['h264_videotoolbox','h264_nvenc','h264_qsv','h264_amf'].includes(selected.id)))return {waiting:'codec',live:true,blocks:[],allBlocks};
    const selectedFont=Object.hasOwn(snapshot,'font')?snapshot.font:this.media.fonts.selected();
    const font=selectedFont?.id?await this.media.fonts.selection(selectedFont.id):selectedFont;
    // Queued jobs own their style. Older jobs keep the previous default;
    // background preparation follows the current settings.
    const danmakuStyle=(Object.hasOwn(snapshot,'danmakuStyle')||Object.hasOwn(snapshot,'mode'))?normalizedDanmakuStyle(snapshot.danmakuStyle):savedDanmakuStyle(this.store);
    const danmakuPerSecond=validateChatRate(snapshot.danmakuPerSecond??chatRate(this.store));
    if(!live&&!Object.hasOwn(snapshot,'linkmicEvents'))await this.store.linkmic?.ensure(id);
    if(live&&!await liveMetadataReady(this.store,sources,options.signal))return {waiting:'metadata',live:true,blocks:[],allBlocks};
    const linkmicEvents=structuredClone(snapshot.linkmicEvents??this.store.linkmic?.events(id)??[]);
    const profile={font:font?.id||null,danmakuStyle,danmakuPerSecond,version:RENDER_VERSION,width,height,fps:danmakuStyle.fps,encoder:selected,arguments:options.cpuCheckpoints?checkpointEncoderArguments(selected):preparedEncoderArguments(selected,this.media.idlePolicy?.threads||2),...(options.cpuCheckpoints?{checkpointSeconds:CPU_CHECKPOINT_SECONDS,cleanClock:'output-v1'}:{})};
    return {id,session,sources,info,font,profile,profileHash:hashRender(profile),linkmicEvents,cpuCheckpoints:!!options.cpuCheckpoints,layout:snapshot.mode==='clean'?[]:await this.layout(id,options.signal,danmakuPerSecond,{width,height,style:danmakuStyle,font}),snapshot:{excluded:new Set(snapshot.excluded||[]),filterLottery:snapshot.filterLottery!==false},blocks:live?liveSelection.blocks:renderBlocks(sources,this.blockSeconds,danmakuStyle.fps),...(live?{live,allBlocks,waiting:liveSelection.waiting,nextEligibleAt:liveSelection.nextEligibleAt,retryAfterMs:liveSelection.retryAfterMs}:{})};
  }
  async sourceFingerprint(source,from,to) {
    const stable=await stableSourceFingerprint(this.store,source,from,to);
    if(stable)return stable;
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
      sourceFingerprint:await this.sourceFingerprint(block.source,span.from,span.to),profileHash:plan.profileHash,assHash:hashRender([commentSignature(events),blockLinkmicEvents(plan.linkmicEvents,block.source.id,span.from,span.to)]),version:1};
  }
  async inspect(file,options={}) {
    const previous=this.encodedInfo.get(file);if(previous)return previous;
    const info=await this.media.probe(file,options);
    this.encodedInfo.set(file,info);while(this.encodedInfo.size>512)this.encodedInfo.delete(this.encodedInfo.keys().next().value);
    return info;
  }
  async renderVideo(plan,source,from,to,file,options={}) {
    return (await this.renderSequence(plan,source,[{from,to,file}],options))[0];
  }
  async renderSequence(plan,source,parts,options={}) {
    const m=this.media,fps=plan.profile.fps,spans=parts.map(p=>frameSpan(p.from,p.to,fps));
    const span=frameSpan(parts[0].from,parts.at(-1).to,fps);
    if(!span.frames||spans.some(s=>!s.frames))throw new Error('选段不足一帧。');
    const sourceInfo=source.id===plan.sources[0].id?plan.info:await m.probeSource(source,span.from,{...options,...(plan.live?{fresh:true}:{})});
    const readFrom=videoReadStart(source,span.from,sourceInfo),base=seekBase(this.store,source.id,readFrom);
    if(base===undefined)throw new Error('正在等待可解码关键帧。');
    const workDir=await m.temporaryDirectory('bili-export-',plan.id);
    try {
      canceled(options.signal);
      const events=plan.cleanVideo?[]:visibleComments(plan.layout,plan.snapshot,span.from,span.to);
      if(!plan.cleanVideo)await fs.writeFile(path.join(workDir,'part-0.ass'),this.assText(events,plan.profile.width,plan.profile.height,plan.font,plan.profile.danmakuStyle));
      const fontDirectory=plan.cleanVideo?null:await m.fonts.stage(plan.font,workDir);
      const geometry=videoGeometryFilter(sourceInfo,plan.profile.width,plan.profile.height);
      const labels=(plan.linkmicEvents||[]).filter(e=>e.source===source.id&&e.time<span.to&&e.end>span.from&&e.participants.length);
      if(labels.length)await fs.writeFile(path.join(workDir,'names.ass'),linkmicAss(labels,plan.profile.width,plan.profile.height,{from:span.from,to:span.to,sourceWidth:sourceInfo.width,sourceHeight:sourceInfo.height}));
      const cards=await avatarFilter(this.store,labels,plan.profile.width,plan.profile.height,workDir,{from:span.from,to:span.to,sourceWidth:sourceInfo.width,sourceHeight:sourceInfo.height});
      const chain=[`setpts=PTS+${base}/TB`,geometry,'format=yuv420p',`tpad=stop_mode=clone:stop_duration=${plan.cleanVideo?Math.max(.1,2/fps):.1}`,`fps=fps=${plan.profile.fps}:start_time=${span.from}:round=near`,plan.cleanVideo?'':`ass=part-0.ass${fontDirectory?':fontsdir='+fontDirectory:''}`,cards,labels.length?'ass=names.ass':'',`trim=start=${span.from}:end=${span.to}`,'setpts=PTS-STARTPTS'].filter(Boolean).join(',');
      const threads=String(m.idlePolicy?.threads||2);
      let frames=0;const cuts=spans.slice(0,-1).map(s=>(frames+=s.frames));
      // These are local intermediate blocks, read by seeking. Faststart only
      // belongs on the final user MP4; moving every block's mdat adds I/O.
      const output=parts.length===1?['-y',parts[0].file]:
        ['-force_key_frames',cuts.map(n=>String(n/fps)).join(','),'-f','segment','-segment_frames',cuts.join(','),'-reset_timestamps','1',
          '-segment_format','mp4','-segment_format_options','video_track_timescale=60000','-y','sequence-%d.mp4'];
      await m.process(['-copyts','-fflags','+genpts','-threads',threads,'-f','flv','-i','pipe:0','-map','0:v:0','-an','-filter_threads',threads,'-vf',chain,
        ...plan.profile.arguments,'-frames:v',String(span.frames),'-r',String(fps),...output],
      {cwd:workDir,input:sourceStream(this.store,source.id,readFrom,Math.min(span.to,options.readTo??span.to),{signal:options.signal}),signal:options.signal,background:options.background,stage:'render'});
      canceled(options.signal);
      const infos=[];let signature;
      for(let i=0;i<parts.length;i++){
        const file=parts.length===1?parts[i].file:path.join(workDir,`sequence-${i}.mp4`),info=await m.probe(file,options);
        const invalidClock=(parts.length>1||plan.cpuCheckpoints)&&(!Number.isFinite(info.startTime)||Math.abs(info.startTime)>.00001||!Number.isFinite(info.duration)||Math.abs(info.duration-spans[i].duration)>.00002);
        if(info.codec!=='h264'||info.audioStreams!==0||info.frames!==spans[i].frames||!info.encodingSignature||signature&&signature!==info.encodingSignature||invalidClock||
          parts.length>1&&info.bFrames!==0)throw new Error('连续分块视频的帧数、时间或编码信息不完整。');
        signature=info.encodingSignature;infos.push(info);
      }
      for(let i=0;i<parts.length;i++){
        if(parts.length>1)await fs.rename(path.join(workDir,`sequence-${i}.mp4`),parts[i].file);
        this.encodedInfo.set(parts[i].file,infos[i]);
      }
      return infos;
    }finally{await m.temporaryWorkspaces.finish(workDir);}
  }
  sequenceAllowed(plan,parts){
    if(this.media.sequenceRendering===false||!sequenceEligible(plan,parts)||!this.store.all)return false;
    if((plan.linkmicEvents||[]).some(e=>e.source===parts[0].source.id&&e.time<parts.at(-1).to&&e.end>parts[0].from&&e.participants.length))return false;
    const rows=this.store.all('SELECT DISTINCT header FROM chunk_identities WHERE source=?',parts[0].source.id);
    return rows.length>0&&new Set(rows.map(row=>codecHeaderSignature(row.header))).size===1;
  }
  async matchesPreparation(jobs){
    const operation=[...this.operations].find(o=>o.sessionId===jobs[0]?.session&&o.plan&&o.blocks?.length);
    if(!operation)return false;
    const plan=operation.plan;
    // A tiny clip must not wait for a long batch it barely overlaps. Only
    // transfer work fully covered by the requested burned-in outputs.
    if(!operation.blocks.every(b=>jobs.some(job=>job.mode!=='clean'&&job.ranges.some(r=>r.start<=b.startMs/1000+.001&&r.end>=b.endMs/1000-.001))))return false;
    // A zero-cache CPU export has its own foreground encoding budget. Do not
    // divert a large cold job into lower-budget cache rendering just to keep
    // its first background block. Existing cache users keep the same path.
    if(!plan.profile.encoder.hardware){
      const covered=jobs.every(job=>exportSegments(plan.sources,job.ranges,job.scope).every(p=>{
        let cursor=p.from;
        for(const b of operation.blocks.filter(b=>b.source.id===p.source.id).toSorted((a,b)=>a.startMs-b.startMs))
          if(b.startMs/1000<=cursor+.001)cursor=Math.max(cursor,b.endMs/1000);
        return cursor>=p.to-.001;
      }));
      if(!covered&&!await this.media.renderCache.hasReady(plan.id))return false;
    }
    const fresh=await this.describe(plan.id,jobs[0],plan.profile.encoder);
    for(const block of operation.blocks)if(hashRender(await this.spec(plan,block))!==hashRender(await this.spec(fresh,block)))return false;
    return this.operations.has(operation);
  }
  renderInputToken(id,block) {
    const to=block.endMs/1000;
    const stamp=this.store.get('SELECT COUNT(*) AS count,COALESCE(MAX(rowid),0) AS last FROM danmaku WHERE session=? AND time<?',id,to);
    const flags=this.store.all('SELECT f.message,f.reason FROM danmaku_filters f JOIN danmaku d ON d.id=f.message WHERE d.session=? AND d.time<? ORDER BY f.message',id,to);
    const edit=this.store.edit(id);
    return hashRender([stamp,this.store.layoutContentRevision,this.store.get('PRAGMA data_version').data_version,flags,[...(edit.excluded||[])].sort(),edit.filterLottery!==false,savedDanmakuStyle(this.store),chatRate(this.store),this.media.fonts.selected()?.id||null,
      blockLinkmicEvents(this.store.linkmic?.events(id)||[],block.source.id,block.startMs/1000,to)]);
  }
  async acquire(plan,block,options={}) {
    const spec=await this.spec(plan,block),cache=this.media.renderCache,span=frameSpan(block.startMs/1000,block.endMs/1000,plan.profile?.fps);
    let lease=await cache.acquire(spec);if(lease)return {...lease,spec};
    lease=await cache.build(spec,options.render|| (async(file,{signal}={})=>this.renderVideo(plan,block.source,block.startMs/1000,block.endMs/1000,file,{...options,signal:signal||options.signal})),
      {signal:options.signal,estimatedBytes:Math.ceil((block.endMs-block.startMs)/1000*2*1024*1024),verifySource:async()=>{
        if(await this.sourceFingerprint(block.source,span.from,span.to)!==spec.sourceFingerprint)return false;
        if(!plan.preparing)return true;
        // Verify against the canonical layout. Ordinary appends can extend its
        // checkpoint; late arrivals and rule changes force a full rebuild.
        const before=this.renderInputToken(plan.id,block);
        const fresh=await this.describe(plan.id,this.store.edit(plan.id),plan.profile.encoder,{...options,live:plan.live});
        if(fresh.waiting&&!fresh.profile)return fresh.waiting==='metadata'?{pending:true}:false;
        const current=await this.spec(fresh,block);
        return before===this.renderInputToken(plan.id,block)&&hashRender(current)===hashRender(spec);
      }});
    return {...lease,spec};
  }
  async prepareNext(id,{signal,onProgress,live}={}) {
    const operation={sessionId:id},leases=[];this.operations.add(operation);
    try {
      const plan=await this.describe(id,this.store.edit(id),null,{signal,background:true,live});
      if(!plan.profile&&plan.waiting)return {done:false,preparedSeconds:0,totalSeconds:(plan.allBlocks||[]).reduce((sum,b)=>sum+(b.endMs-b.startMs)/1000,0),bytes:0,waiting:plan.waiting,live:true,retryAfterMs:plan.retryAfterMs||10000,...(plan.waiting==='tail'&&plan.nextEligibleAt!==undefined?{nextEligibleAt:plan.nextEligibleAt}:{})};
      plan.preparing=true;operation.plan=plan;
      const seconds=block=>frameSpan(block.startMs/1000,block.endMs/1000,plan.profile?.fps).duration;
      const totalSeconds=(plan.allBlocks||plan.blocks).reduce((sum,b)=>sum+seconds(b),0);
      const fingerprints=[],liveComments=live?[]:null,liveLabels=live?[]:null;
      for(const source of plan.sources){
        canceled(signal);
        const selected=live?plan.blocks.filter(block=>block.source.id===source.id):null;
        if(live&&!selected.length)continue;
        const from=live?selected[0].startMs/1000:source.start,to=live?selected.at(-1).endMs/1000:source.start+source.duration;
        fingerprints.push(await this.sourceFingerprint(source,from,to));
        if(live){liveComments.push(commentSignature(visibleComments(plan.layout,plan.snapshot,from,to)));liveLabels.push(blockLinkmicEvents(plan.linkmicEvents,source.id,from,to));}
      }
      const signature=hashRender([plan.profileHash,[...plan.snapshot.excluded].sort(),plan.snapshot.filterLottery,live?liveLabels:plan.linkmicEvents,fingerprints,liveComments,this.blockSeconds]);
      const cache=this.media.renderCache;
      let state=this.preparationPlans.get(id);
      if(!state||state.signature!==signature||(!live&&state.layout!==plan.layout)||state.revision!==cache.revision) {
        state={signature,layout:plan.layout,preparedSeconds:0,totalSeconds,bytes:0,missing:[],ready:[]};
        for(const block of plan.blocks) {
          canceled(signal);const spec=await this.spec(plan,block),lease=await cache.acquire(spec);
          if(lease){state.preparedSeconds+=seconds(block);state.bytes+=lease.bytes;leases.push(lease);state.ready.push({block,spec,bytes:lease.bytes});}
          else state.missing.push(block);
        }
        state.revision=cache.revision;this.preparationPlans.delete(id);this.preparationPlans.set(id,state);
        while(this.preparationPlans.size>2)this.preparationPlans.delete(this.preparationPlans.keys().next().value);
      } else {
        // Revalidate and pin completed cache files without rebuilding every
        // comment signature/source interval. Never evict this material's own
        // completed blocks to make space for its next block.
        for(const ready of [...state.ready]) {
          canceled(signal);const lease=await cache.acquire(ready.spec);
          if(lease)leases.push(lease);
          else { state.ready.splice(state.ready.indexOf(ready),1);state.missing.push(ready.block);state.preparedSeconds-=seconds(ready.block);state.bytes-=ready.bytes; }
        }
      }
      const report=()=>({preparedSeconds:state.preparedSeconds,totalSeconds,bytes:state.bytes});
      onProgress?.(report());
      if(state.missing.length) {
        const media=this.media,policy=media.idlePolicy,decision=live?{concurrency:1,reason:'live-recording'}:policy?await policy.choose(id,signature,plan,state.missing,cache):{concurrency:1};
        const timing=media.preparationContext?.getStore();if(timing)timing.policy={...decision};
        let batch=state.missing.slice(0,decision.concurrency);
        const adjacent=state.missing.slice(0,2).map(b=>({...b,from:b.startMs/1000,to:b.endMs/1000}));
        const sequenceBytes=adjacent.reduce((sum,p)=>sum+Math.ceil((p.to-p.from)*2*1024**2),0);
        const cacheUsed=[...(cache.entries?.values()||[])].reduce((sum,e)=>sum+e.bytes,0);
        if(decision.concurrency===1&&!['last-block','cache-budget','disk-pressure','memory-pressure','small-device','resources-unavailable'].includes(decision.reason)&&
          this.sequenceAllowed(plan,adjacent)&&cacheUsed+(cache.reserved||0)+sequenceBytes<=cache.maxBytes)batch=state.missing.slice(0,2);
        operation.blocks=batch;
        const started=performance.now();
        const waitBefore=Object.values(timing?.stages||{}).reduce((sum,stage)=>sum+stage.waitMs,0);
        const run=async(blocks,capacity)=>{
          const revision=cache.revision,controller=new AbortController(),batchSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
          let firstError;
          const work=async()=>{
            // Acquire protects disk reservations and finished-block leases.
            // Abort siblings on error, but never release their workspaces or
            // current-plan pins before every child process has actually closed.
            const parts=blocks.map(b=>({...b,from:b.startMs/1000,to:b.endMs/1000}));
            const sequence=capacity===1&&this.sequenceAllowed(plan,parts)?renderRendezvous(parts.length,async(files,signal)=>{
              const selected=parts.flatMap((p,i)=>files[i]?[{...p,file:files[i]}]:[]);
              try{if(selected.length)await this.renderSequence(plan,selected[0].source,selected,{signal,background:true});}
              catch(error){canceled(signal);this.media.assertExportActive?.();if(this.media.closed||mediaFailure(error)==='action')throw error;
                for(const p of selected)await this.renderVideo(plan,p.source,p.from,p.to,p.file,{signal,background:true});}
            }):null;
            const results=await Promise.allSettled(blocks.map(async(block,index)=>{
              try{const lease=await this.acquire(plan,block,{signal:batchSignal,background:true,...(sequence?{render:(file,options)=>sequence.render(index,file,options)}:{})});sequence?.skip(index);leases.push(lease);return {block,lease,spec:lease.spec??await this.spec(plan,block)};}
              catch(error){firstError??=error;controller.abort();sequence?.stop(error);throw error;}
            }));
            await sequence?.settle();
            let completed=0;
            for(const result of results)if(result.status==='fulfilled'){
              const {block,lease,spec}=result.value;state.preparedSeconds+=seconds(block);state.bytes+=lease.bytes;
              state.missing.splice(state.missing.indexOf(block),1);state.ready.push({block,spec,bytes:lease.bytes});completed++;
            }
            // Revisions created only by this batch retain the cursor. Any
            // concurrent eviction/change causes a fresh scan next turn.
            if(cache.revision>=revision&&cache.revision<=revision+completed)state.revision=cache.revision;
            onProgress?.(report());
            return {firstError,failed:blocks.filter(block=>state.missing.includes(block))};
          };
          return media.withBackgroundBatch?media.withBackgroundBatch(capacity,work):work();
        };
        const result=await run(batch,decision.concurrency);
        if(result.firstError){
          // The same encoder/profile is retained on serial recovery. Completed
          // siblings stay valid; a cancelled/incomplete block is never a hit.
          if(decision.concurrency===2&&!signal?.aborted&&!media.closed&&!['PREP_SPACE','PREP_STALE','PREP_CANCELLED'].includes(result.firstError.code)){
            if(policy)policy.state(id,signature).decision='serial';
            for(const block of result.failed){const retry=await run([block],1);if(retry.firstError)throw retry.firstError;}
            if(timing)timing.policy={...decision,decision:'serial',reason:'parallel-failed'};
          }else throw result.firstError;
        }else {
          const elapsed=performance.now()-started,wait=Object.values(timing?.stages||{}).reduce((sum,stage)=>sum+stage.waitMs,0)-waitBefore;
          if(!live&&!signal?.aborted&&wait<Math.max(50,elapsed*.05)&&!['short-block','last-block'].includes(decision.reason))policy?.observe(id,signature,decision,batch.reduce((sum,block)=>sum+seconds(block),0),elapsed);
          if(!live&&timing&&policy?.last)timing.policy={...policy.last};
        }
        canceled(signal);
      }
      return {done:!live&&!state.missing.length&&state.revision===cache.revision,...report(),...(live?{live:true,...(!state.missing.length?{waiting:plan.waiting||'tail',retryAfterMs:plan.retryAfterMs||10000,...(plan.waiting==='tail'&&plan.nextEligibleAt!==undefined?{nextEligibleAt:plan.nextEligibleAt}:{})}:{})}:{})};
    }catch(error){
      if(live&&['PREP_STALE','PREP_SOURCE_STALE','PREP_PENDING'].includes(error.code)){this.preparationPlans.delete(id);return {done:false,preparedSeconds:0,totalSeconds:0,bytes:0,live:true,waiting:error.code==='PREP_SOURCE_STALE'?'codec':'metadata',retryAfterMs:10000};}
      throw error;
    }finally{try{for(const lease of leases)await lease.release();}finally{this.operations.delete(operation);}}
  }
  async foregroundParts(plan,segments,leases) {
    if(plan.cpuCheckpoints)return segments.flatMap(segment=>checkpointSpans(segment.from,segment.to,plan.profile.fps).map(span=>({...span,source:segment.source})));
    const result=[];
    for(const segment of segments) {
      const partition=splitForCache(segment,plan.blocks);let hits=0;
      for(let i=0;i<partition.length;i++) {
        const part=partition[i];if(!frameSpan(part.from,part.to,plan.profile?.fps).frames)continue;
        const lease=await this.media.renderCache.acquire(await this.spec(plan,part));
        if(!lease)continue;
        if(part.complete){leases.push(lease);part.file=lease.file;part.cached=true;hits++;continue;}
        let retained=false;
        try{
          const info=await this.inspect(lease.file);let index=this.sliceIndexes.get(lease.file);
          if(index===undefined){
            index=info.bFrames===0?cachedVideoIndex(info,await this.media.probePackets(lease.file),plan.profile.fps):null;
            this.sliceIndexes.set(lease.file,index);while(this.sliceIndexes.size>8)this.sliceIndexes.delete(this.sliceIndexes.keys().next().value);
          }
          const pieces=index&&splitCachedVideo({...part,cacheFile:lease.file},index,plan.profile.fps);
          if(pieces){leases.push(lease);retained=true;partition.splice(i,1,...pieces);i+=pieces.length-1;hits++;}
        }catch(error){this.media.assertExportActive?.();if(this.media.closed)throw error;}
        finally{if(!retained)await lease.release();}
      }
      // A completely cold interval can be balanced without disturbing the
      // canonical boundaries of any existing sixty-second cache blocks.
      result.push(...(hits?partition:balancedSpans(segment.from,segment.to,plan.profile?.fps).map(span=>({...span,source:segment.source}))));
    }
    return result.filter(part=>frameSpan(part.from,part.to,plan.profile?.fps).frames>0);
  }
  async renderForegroundParts(plan,parts,workDir,{onProgress,checkpoint}={}) {
    const prepared=parts.map((part,index)=>({...part,file:part.file||path.join(workDir,`part-${index}${plan.cleanVideo?'-danmaku':''}.mp4`),duration:frameSpan(part.from,part.to,plan.profile?.fps).duration}));
    const missing=prepared.filter(part=>!part.cached),cachedDuration=prepared.filter(part=>part.cached).reduce((sum,part)=>sum+part.duration,0),completedParts=new Set();
    const parallel=plan.profile.encoder.hardware&&missing.length>1;let reported=0;
    const progress=value=>{reported=Math.max(reported,value);onProgress?.(reported);};
    const attempt=async concurrency=>{
      const pending=missing.filter(part=>!completedParts.has(part)),remaining=[];
      for(let i=0;i<pending.length;i++){
        const pair=pending.slice(i,i+2);
        // Hardware foreground batching was slower in the local ABBA check.
        // Keep its independent bounded workers; idle preparation may batch.
        if(!plan.cpuCheckpoints&&!plan.profile.encoder.hardware&&this.sequenceAllowed(plan,pair)){remaining.push(pair);i++;}else remaining.push([pending[i]]);
      }
      const controller=new AbortController();let cursor=0,completed=cachedDuration+[...completedParts].reduce((sum,part)=>sum+part.duration,0),firstError;
      progress(completed);
      const worker=async()=>{
        while(!controller.signal.aborted) {
          try {
            if(this.media.closed)throw new Error('视频服务已关闭。');
            const unit=remaining[cursor++];if(!unit)return;
            const renderUnit=async()=>{
            if(unit.length>1){
              try{await this.renderSequence(plan,unit[0].source,unit,{signal:controller.signal});}
              catch(error){this.media.assertExportActive?.();canceled(controller.signal);if(this.media.closed||mediaFailure(error)==='action'||mediaFailure(error)==='temporary')throw error;
                for(const part of unit)await this.renderVideo(plan,part.source,part.from,part.to,part.file,{signal:controller.signal});}
              canceled(controller.signal);
              return;
            }
            const part=unit[0],renderOptions={signal:controller.signal,...(part.readTo===undefined?{}:{readTo:part.readTo})};
            this.encodedInfo.delete(part.file);
            if(part.reuse){
              try{
                const r=part.reuse;
                await this.media.process(['-ss',String(r.from),'-i',r.file,'-t',String(r.to-r.from),'-map','0:v:0','-an','-c:v','copy',
                  '-video_track_timescale','60000','-movflags','+faststart','-y',part.file],{signal:controller.signal,stage:'copy'});
                const info=await this.inspect(part.file);
                if(info.frames!==r.frames||info.bFrames!==0||!Number.isFinite(info.startTime)||!Number.isFinite(info.duration)||Math.abs(info.startTime)>.00001||
                  Math.abs(info.duration-(r.to-r.from))>.00001||info.encodingSignature!==r.signature)throw new Error('缓存裁剪的帧数、时间或编码签名不一致。');
                part.reusedSlice=true;
              }catch(error){
                this.media.assertExportActive?.();canceled(controller.signal);if(this.media.closed||mediaFailure(error)==='action'||mediaFailure(error)==='temporary')throw error;
                this.encodedInfo.delete(part.file);part.reuseFallback=error.message;
                await this.renderVideo(plan,part.source,part.from,part.to,part.file,renderOptions);
              }
            }else await this.renderVideo(plan,part.source,part.from,part.to,part.file,renderOptions);
            };
            if(checkpoint)await checkpoint.run(hashRender(unit.map(p=>[p.source.id,p.from,p.to,path.basename(p.file)])),renderUnit,unit.map(p=>path.basename(p.file)));
            else await renderUnit();
            canceled(controller.signal);for(const part of unit){completedParts.add(part);completed+=part.duration;}progress(completed);
          }catch(error){firstError??=error;controller.abort();throw error;}
        }
      };
      const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,Math.max(1,remaining.length))},worker));
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
    const result=files=>({files,reused:prepared.filter(p=>p.cached||p.reusedSlice).length,
      reusedSeconds:prepared.filter(p=>p.cached||p.reusedSlice).reduce((sum,p)=>sum+p.duration,0),
      renderedSeconds:prepared.filter(p=>!p.cached&&!p.reusedSlice).reduce((sum,p)=>sum+p.duration,0)});
    try{return result(await attempt(parallel?2:1));}
    catch(error) {
      this.media.assertExportActive?.();
      if(this.media.closed||!parallel||error.code==='PREP_INCOMPATIBLE'||['action','temporary'].includes(mediaFailure(error)))throw error;
      // The first attempt has fully settled, including aborted siblings. A
      // device with only one available encoding session may still work serially.
      try{return {...result(await attempt(1)),serialRetry:true,serialReason:error.message};}
      catch(retry){if(!this.media.closed&&retry.code!=='PREP_INCOMPATIBLE'&&!['action','temporary'].includes(mediaFailure(retry)))retry.hardwareEncoderFailure=true;throw retry;}
    }
  }
  async audio(segments,plan,workDir,job,checkpoint) {
    let infos=await Promise.all(segments.map(({source,from})=>source.id===plan.sources[0].id?plan.info:this.media.probeSource(source,from)));
    if(infos.every(info=>info.audioStreams===0))return null;
    if(!job.audioStreamCopyFallback&&plan.sourceExport?.canCopyStreams){
      try{
        const copied=await copyFullAudio(this.media,plan.sourceExport,plan.profile.fps,workDir);
        if(copied){job.audioStreamCopy=true;return copied;}
      }catch(error){
        this.media.assertExportActive?.();if(this.media.closed||['action','temporary'].includes(mediaFailure(error)))throw error;
        if(error.code!=='AUDIO_COPY_UNSAFE'&&!/AAC|音轨|拼接|音频|视频处理失败/.test(error.message))throw error;
        job.audioCopyFallback=error.message;
      }
    }
    const single=segments[0],base=seekBase(this.store,single.source.id,single.from);
    if(!job.audioCopyFallback&&!job.audioStreamCopyFallback&&(plan.sourceExport?.canCopyStreams??true)&&infos[0].audioCodec==='aac'&&canCopyFullSource(job,plan.sources,infos[0],base)) {
      await this.media.process(['-copyts','-f','flv','-i','pipe:0','-map','0:a:0','-vn','-c:a','copy','-movflags','+faststart','-y','audio.m4a'],
        {cwd:workDir,stage:'audio',input:sourceStream(this.store,single.source.id,single.from,single.to)});
      return 'audio.m4a';
    }
    // Repair/decode bounded lossless audio blocks, then encode AAC once. This
    // keeps sample continuity and avoids AAC priming at every video checkpoint.
    if(plan.cpuCheckpoints){
      const pieces=segments.flatMap((segment,i)=>checkpointSpans(segment.from,segment.to,plan.profile.fps).map(span=>({...span,source:segment.source,info:infos[i]})));
      segments=pieces;infos=pieces.map(piece=>piece.info);
    }
    const files=[];
    for(let i=0;i<segments.length;i++) {
      const {source,from,to}=segments[i],span=frameSpan(from,to,plan.profile?.fps),name=`audio-${i}.flac`;
      if(!span.frames)continue;
      const samples=Math.round(span.duration*48000);
      // Both supported frame rates (30/60) produce multiples of 800 samples at
      // 48 kHz. Uniform lossless blocks avoid a short final FLAC block changing
      // the decoder's block limit before the next concatenated file starts.
      const encoding=['-c:a','flac','-compression_level','0',...(segments.length>1?['-sample_fmt','s32','-frame_size','800']:[])];
      const render=async()=>{if(infos[i].audioStreams===0) {
        await this.media.process(['-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',String(span.duration),...encoding,'-y',name],{cwd:workDir,stage:'audio'});
      } else {
        const base=seekBase(this.store,source.id,Math.max(source.start,span.from));
        const filter=`aresample=48000:async=1:first_pts=0,atrim=start=${Math.max(0,span.from-base)}:end=${span.to-base},asetpts=PTS-STARTPTS,apad=whole_len=${samples},atrim=end_sample=${samples}`;
        await this.media.process(['-copyts','-threads','2','-f','flv','-i','pipe:0','-map','0:a:0','-vn','-af',filter,'-ar','48000','-ac','2',...encoding,'-y',name],
          {cwd:workDir,stage:'audio',input:audioSourceStream(this.store,source,Math.max(source.start,span.from),span.to)});
      }};
      if(checkpoint)await checkpoint.run(hashRender(['audio',source.id,span.from,span.to,name]),render,[name]);else await render();
      files.push(name);
    }
    await fs.writeFile(path.join(workDir,'audio-concat.txt'),files.map(name=>`file '${name}'`).join('\n'));
    await this.media.process(['-xerror','-f','concat','-safe','1','-i','audio-concat.txt','-vn','-c:a','aac','-b:a','192k','-movflags','+faststart','-y','audio.m4a'],{cwd:workDir,stage:'audio'});
    return 'audio.m4a';
  }
  async cleanVideos(segments,plan,encoder,workDir,job,checkpoint) {
    if(plan.cpuCheckpoints){
      const cleanPlan={...plan,cleanVideo:true,profile:{...plan.profile,fps:plan.info.fps}};
      const parts=cleanCheckpointParts(segments,plan.profile.fps,cleanPlan.profile.fps);
      const total=parts.reduce((sum,p)=>sum+p.to-p.from,0),start=job.mode==='clean'?.1:.85,end=job.mode==='clean'?.9:.94;
      return (await this.renderForegroundParts(cleanPlan,parts,workDir,{checkpoint,onProgress:processed=>
        this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(end,start+(end-start)*processed/total),job.id)})).files;
    }
    const files=[];
    for(let i=0;i<segments.length;i++) {
      const {source,from,to}=segments[i],span=frameSpan(from,to,plan.profile?.fps),base=seekBase(this.store,source.id,from),name=`part-${i}-danmaku.mp4`;
      const info=source.id===plan.sources[0].id?plan.info:await this.media.probeSource(source,from);
      const labels=(plan.linkmicEvents||[]).filter(e=>e.source===source.id&&e.time<to&&e.end>from&&e.participants.length);
      if(!labels.length&&(plan.sourceExport?.canCopyOriginal??true)&&canCopyFullSource(job,plan.sources,info,base)) {
        await this.media.process(['-copyts','-f','flv','-i','pipe:0','-map','0:v:0','-an','-c:v','copy','-movflags','+faststart','-y',name],
          {cwd:workDir,input:sourceStream(this.store,source.id,from,to)});
        files.push({file:path.join(workDir,name),duration:span.duration});continue;
      }
      const geometry=videoGeometryFilter(info,plan.profile.width,plan.profile.height);
      const labelFile=`clean-names-${i}.ass`;
      if(labels.length)await fs.writeFile(path.join(workDir,labelFile),linkmicAss(labels,plan.profile.width,plan.profile.height,{base,from,to,sourceWidth:info.width,sourceHeight:info.height}));
      const cards=await avatarFilter(this.store,labels,plan.profile.width,plan.profile.height,workDir,{base,from,to,sourceWidth:info.width,sourceHeight:info.height});
      const filters=[geometry,cards,labels.length?`ass=${labelFile}`:''].filter(Boolean).join(',');
      await this.media.process(['-copyts','-threads','2','-f','flv','-i','pipe:0','-ss',String(Math.max(0,span.from-base)),'-t',String(span.duration),'-map','0:v:0','-an',
        ...(filters?['-vf',filters]:[]),...preparedEncoderArguments(encoder),'-r',String(plan.info.fps),'-movflags','+faststart','-y',name],
        {cwd:workDir,input:sourceStream(this.store,source.id,from,to)});
      files.push({file:path.join(workDir,name),duration:span.duration});
    }
    return files;
  }
  async mux(files,audio,name,workDir,listName) {
    const videoInput=files.length===1?['-i',files[0].file]:['-f','concat','-safe','0','-i',listName];
    if(files.length>1)await fs.writeFile(path.join(workDir,listName),'ffconcat version 1.0\n'+files.map(item=>`file '${concatPath(item.file)}'\nduration ${item.duration}`).join('\n'));
    const duration=files.reduce((sum,item)=>sum+item.duration,0);
    await this.media.process(['-copyts',...videoInput,...(audio?['-i',audio]:[]),'-map','0:v:0',...(audio?['-map','1:a:0']:['-an']),'-c','copy','-t',String(duration),'-movflags','+faststart','-y',name],{cwd:workDir,stage:'mux'});
  }
  async exportJob(job,encoder,sourcePlan,{cpuCheckpoints=false}={}) {
    const m=this.media,plan=await this.describe(job.session,job,encoder,{cpuCheckpoints}),segments=exportSegments(plan.sources,job.ranges,job.scope);
    sourcePlan??=await sourceExportPlan(m,job,plan.sources,plan.info);
    plan.sourceExport=sourcePlan;
    const leases=[];let checkpoint;
    try {
      const total=segments.reduce((sum,item)=>sum+frameSpan(item.from,item.to,plan.profile?.fps).duration,0);
      const cleanOnly=job.mode==='clean';
      const parts=cleanOnly?[]:await this.foregroundParts(plan,segments,leases);
      if(!cleanOnly&&!parts.length)throw new Error('选段中没有完整视频帧。');
      // A cache may exist for a different style/selection. Only actual matches
      // justify the preparation profile; never discard a persisted route.
      if(!cpuCheckpoints&&!encoder.hardware&&!job.processingRecovery&&total>=CPU_CHECKPOINT_SECONDS&&!parts.some(p=>p.cached||p.reuse)){
        for(const lease of leases.splice(0))await lease.release();
        return await this.exportJob(job,encoder,sourcePlan,{cpuCheckpoints:true});
      }
      checkpoint=await m.exportWorkspace(job,{route:cpuCheckpoints?CPU_EXPORT_ROUTE:'prepared-v9',encoder,profile:plan.profile,comments:commentSignature(plan.layout),segments});
      const workDir=checkpoint.directory;
      if(cpuCheckpoints)job.cpuCheckpointSeconds=CPU_CHECKPOINT_SECONDS;
      const {files,reused,reusedSeconds,renderedSeconds,serialRetry,serialReason}=cleanOnly?{files:[],reused:0,reusedSeconds:0,renderedSeconds:0}:await this.renderForegroundParts(plan,parts,workDir,{checkpoint,onProgress:processed=>
        this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.8,.05+.75*processed/total),job.id)});
      if(serialRetry){job.parallelRenderFallback=true;job.parallelRenderFallbackReason=serialReason;}
      if(!cleanOnly&&!files.length)throw new Error('选段中没有完整视频帧。');
      const dual=job.mode==='dual';let audio,originalCopied=false;
      if((dual||cleanOnly)&&sourcePlan.canCopyOriginal){
        try{
          await checkpoint.run('clean-original',()=>copyOriginal(m,sourcePlan,workDir),['final.mp4']);
          originalCopied=true;job.cleanStreamCopy=true;
          audio=sourcePlan.entries[0].info.audioStreams===1?'final.mp4':null;
          if(audio)job.audioStreamCopy=true;
        }catch(error){
          m.assertExportActive?.();if(m.closed||mediaFailure(error)==='action'||mediaFailure(error)==='temporary')throw error;
          job.cleanStreamCopy=false;job.streamCopyFallback=true;job.cleanEncodingReason=error.message;
          if(/(?:malformed AAC bitstream|AAC bitstream[^\r\n]*(?:ADTS|extradata)|could not find tag for codec aac)/i.test(error.message))job.audioStreamCopyFallback=true;
          // Keep every validated burned-in block. A failed original-picture
          // remux only rebuilds the clean/audio outputs, never the baked video.
        }
      }
      if(!originalCopied)audio=await checkpoint.run('audio',()=>this.audio(segments,plan,workDir,job,checkpoint),name=>name?[name]:[]);
      this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',cleanOnly?.1:.85,job.id);
      const bakedName=dual?'final-danmaku.mp4':'final.mp4';
      if(!cleanOnly)await checkpoint.run('baked-final',()=>this.mux(files,audio,bakedName,workDir,'video-concat-danmaku.txt'),[bakedName]);
      if((dual||cleanOnly)&&!originalCopied)await checkpoint.run('clean-final',async()=>this.mux(await this.cleanVideos(segments,plan,encoder,workDir,job,checkpoint),audio,'final.mp4',workDir,'video-concat.txt'),['final.mp4']);
      this.store.run("UPDATE jobs SET status='finalizing',progress=.95 WHERE id=?",job.id);
      const results=dual?[{temporary:'final.mp4',file:job.output.file},{temporary:'final-danmaku.mp4',file:clipFile(job.output.file,'danmaku')}]:[{temporary:'final.mp4',file:cleanOnly?job.output.file:clipFile(job.output.file,'danmaku')}];
      if(cleanOnly)delete job.output.danmakuFile;else job.output.danmakuFile=clipFile(job.output.file,'danmaku');
      job.preparedBlocks=reused;job.reusedVideoSeconds=reusedSeconds;job.renderedVideoSeconds=renderedSeconds;
      return await m.publishFiles(job,workDir,results);
    }finally {
      for(const lease of leases)await lease.release();
      if(checkpoint)for(const file of this.encodedInfo.keys())
        if(path.dirname(file)===checkpoint.directory)this.encodedInfo.delete(file);
      await checkpoint?.finish();
    }
  }
}
