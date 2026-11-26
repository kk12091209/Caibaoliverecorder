import { stopChild } from './child-stop.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { DanmakuFonts, danmakuAssSize } from './danmaku-font.js';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sourceStream, seekBase } from './ingest.js';
import {sourceExportPlan,copyOriginal,exportSegments} from './export-plan.js';
import { validateRanges } from './store.js';
import { directories, writableDirectory, exportScopeDirectory } from './directories.js';
import { outputSpan, reserveClip, reserveFull, clipFile } from './output-names.js';
import { detectExportEncoder, encoderArguments, softwareEncoder, videoMetadata, videoGeometryFilter, canCopyFullSource } from './export-encoding.js';
import { TemporaryWorkspaces } from './temp-workspaces.js';
import { ExportPublication } from './export-publication.js';
import { RenderCache } from './render-cache.js';
import { RenderPipeline, visibleComments, CPU_EXPORT_ROUTE, CPU_CHECKPOINT_SECONDS } from './render-plan.js';
import { danmakuGeometry, assOpacity, savedDanmakuStyle, normalizedDanmakuStyle, danmakuDuration } from '../shared/danmaku-style.js';
import { savedRecordingStyle, originalRecordingStyle, blockCameraEvents } from '../shared/recording-style.js';
import { recordingLayoutFilter } from './recording-layout.js';
import { chatRate } from './chat-rules.js';
import { scrollingTracks, danmakuText } from '../shared/danmaku-tracks.js';
import { PreviewRequests } from './preview-requests.js';
import { linkmicAss } from './linkmic.js';
import { avatarFilter } from './linkmic-avatars.js';
import { MediaScheduler } from './media-scheduler.js';
import { IdleRenderPolicy } from './idle-render-policy.js';
import {ExportCheckpoints} from './export-checkpoints.js';
import {retryMedia as retryMediaWork,mediaFailure} from './media-retry.js';
import {hashRender,commentSignature} from './render-plan.js';
import {giftMessages,giftAss} from './gifts.js';
import {giftIconFilter} from './gift-icons.js';
import {savedGiftStyle} from '../shared/gifts.js';
import {savedHighlightStyle} from '../shared/highlight-style.js';

function assTime(t) { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60; return `${h}:${String(m).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`; }
export function assText(messages, width = 1280, height = 720, font = null, style,highlightStyle) {
  const geometry=danmakuGeometry(height,style),{size,lineHeight,top,lanes:laneCount}=geometry,alpha=assOpacity(style),shadowAlpha=assOpacity(style,128);
  const clip=geometry.clipTop>0||geometry.clipBottom<height?`\\clip(0,${Math.ceil(geometry.clipTop)},${width},${Math.floor(geometry.clipBottom)})`:'';
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font?.family||'Microsoft YaHei'},${danmakuAssSize(size,font)},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}111111,&H${shadowAlpha}000000,${font?.bold?-1:0},${font?.italic?-1:0},0,0,100,100,0,0,1,1.5,0,7,20,20,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const planned=messages.every(m=>Number.isInteger(m.lane)&&m.lane>=0&&m.lane<laneCount&&Number.isFinite(m.textWidth)&&m.textWidth>0)?messages:scrollingTracks(messages,{width,height,...geometry,duration:danmakuDuration(style),font,highlightStyle});
  return head + planned.map(m => {
    const seconds=Number.isFinite(m.end)?m.end-m.time:danmakuDuration(style);
    if(m.time+seconds<=0)return '';
    const lane=m.lane,content=danmakuText(m.text),xEnd=-m.textWidth,y=Number.isFinite(m.y)?m.y:top+lane*lineHeight;
    const delay=m.entryDelay||0,elapsed=Math.max(0,-m.time),speed=(width+m.textWidth)/(seconds-delay);
    const startX=width-Math.max(0,elapsed-delay)*speed;
    const movement=delay?`,${Math.round(Math.max(0,delay-elapsed)*1000)},${Math.round((seconds-elapsed)*1000)}`:'';
    const highlighted=m.highlighted===true,color=Number.isFinite(m.renderColor)?m.renderColor:16777215;
    const bgr=[color&255,color>>8&255,color>>16&255].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
    const decoration=`${Number.isFinite(m.fontSize)?'\\fs'+danmakuAssSize(m.fontSize,font):''}${highlighted?'\\1c&H'+bgr+'&':''}`;
    return `Dialogue: 0,${assTime(m.time)},${assTime(m.time+seconds)},Default,,0,0,0,,{\\move(${startX},${y},${xEnd},${y}${movement})${clip}${decoration}}${content}\n`;
  }).join('');
}

export class Media {
  exportContext = new AsyncLocalStorage();
  preparationContext = new AsyncLocalStorage();
  preparationShutdown = new AbortController();
  preparationCalls = new Map();
  preparationMetrics = new Map();
  backgroundBatches = new Set();
  foregroundBatches = new Set();
  exportOperations = new Map();
  preparationHandoffs = new Map();
  checkpoints = new ExportCheckpoints(this);
  previewRequests = new PreviewRequests();
  exportSignal(signal) {
    const jobSignal=this.exportContext?.getStore()?.controller.signal;
    return jobSignal?(signal?AbortSignal.any([signal,jobSignal]):jobSignal):signal;
  }
  assertExportActive() {
    if(this.exportContext?.getStore()?.controller.signal.aborted)throw Object.assign(new Error('导出已取消。'),{code:'EXPORT_CANCELLED'});
  }
  persistExportJob(job){
    if(!this.closed&&typeof job?.id==='string'&&this.store.get('SELECT id FROM jobs WHERE id=?',job.id))
      this.store.run('UPDATE jobs SET data=? WHERE id=?',JSON.stringify(job),job.id);
  }
  retryMedia(work,options={}){
    const operation=this.exportContext?.getStore(),signal=this.exportSignal(options.signal);
    const retries=operation?Math.min(options.retries??2,Math.max(0,6-(operation.job.automaticRetries||0))):options.retries;
    return retryMediaWork(work,{...options,...(retries===undefined?{}:{retries}),signal,allowRetry:()=>!operation||(operation.job.automaticRetries||0)<6,report:event=>{
      if(operation){operation.job.automaticRetries=(operation.job.automaticRetries||0)+1;try{this.persistExportJob(operation.job);}catch{}}
      this.store.diagnostics?.record('媒体自动重试',`临时读写故障 ${event.code}，重试 ${event.attempt}/${event.retries}`,{level:'警告'});
      options.report?.(event);
    }});
  }
  async exportWorkspace(job,details){
    this.store.exportCheckpoints=this.checkpoints;
    const sources=this.store.sources(job.session);
    const temporary=async()=>{const directory=await this.temporaryDirectory('bili-export-',job.session);return {directory,run:(_key,work)=>this.retryMedia(work),finish:()=>this.temporaryWorkspaces.finish(directory)};};
    if(!this.checkpoints||sources.some(s=>s.closed!==2)||!this.store.get('SELECT id FROM jobs WHERE id=?',job.id)){
      return temporary();
    }
    const inputs=[];
    for(const {source,from,to} of details.segments){
      let fingerprint;
      try{fingerprint=await this.renderer.sourceFingerprint(source,from,to);}
      catch(error){
        if(error.code!=='PREP_SOURCE_STALE')throw error;
        // An unverifiable optimization index must not block a normal export
        // from readable original material. Never reuse an old checkpoint here.
        await this.checkpoints.discard(job);job.checkpointWarning='来源索引无法用于断点复用，本次从原素材重新处理。';this.persistExportJob(job);return temporary();
      }
      inputs.push([source.id,from,to,fingerprint]);
    }
    const snapshot=[job.mode,job.scope,job.ranges,job.excluded,job.filterLottery,job.font,job.danmakuStyle,job.danmakuPerSecond,job.linkmicEvents,job.highlightStyle,job.highlighted,job.messageEdits];
    if(Object.hasOwn(job,'recordingStyle'))snapshot.push(job.recordingStyle,job.cameraEvents);
    if(job.gifts?.length)snapshot.push(job.gifts,job.giftIcons);
    const checkpoint=await this.checkpoints.open(job,hashRender([details.route,details.encoder,details.profile,details.comments,inputs,snapshot]));
    job.processingRecovery.route=details.route;this.persistExportJob(job);return checkpoint;
  }
  async cancelExport(id) {
    const row=this.store.get('SELECT * FROM jobs WHERE id=?',id);
    if(!row)throw new Error('导出任务不存在。');
    if(['cancelled','canceled'].includes(row.status))return {ok:true,status:'cancelled'};
    if(row.status==='queued') {
      this.store.run("UPDATE jobs SET status='cancelled',error='' WHERE id=? AND status='queued'",id);
      const handoff=this.preparationHandoffs?.get(id);this.preparationHandoffs?.delete(id);await handoff?.release(id);
      const job=JSON.parse(row.data);await this.checkpoints?.discard(job);this.persistExportJob(job);
      await this.releaseReservation(job);
      return {ok:true,status:'cancelled'};
    }
    const operation=this.exportOperations.get(id);
    if(!['running','finalizing','cancelling'].includes(row.status)||!operation)throw new Error(row.status==='saving'?'成片正在保存，完成后可删除。':'该导出任务当前无法取消。');
    this.store.run("UPDATE jobs SET status='cancelling',error='' WHERE id=?",id);
    operation.controller.abort();
    await operation.done.catch(()=>{});
    this.store.run("UPDATE jobs SET status='cancelled',error='' WHERE id=? AND status='cancelling'",id);
    return {ok:true,status:this.store.get('SELECT status FROM jobs WHERE id=?',id)?.status};
  }
  exportJob(job) {
    if(this.exportOperations.has(job.id))throw new Error('这个导出任务正在执行。');
    const operation={job,controller:new AbortController(),done:null,started:performance.now(),stages:{}};
    this.exportOperations.set(job.id,operation);
    operation.done=this.exportContext.run(operation,()=>Promise.resolve().then(()=>{this.assertExportActive();return this.performExportJob(job);}))
      .catch(error=>{if(operation.yielded)error.automaticYield=true;throw error;})
      .finally(async()=>{
        const handoff=this.preparationHandoffs?.get(job.id);this.preparationHandoffs?.delete(job.id);await handoff?.release(job.id);
        if(operation.controller.signal.aborted&&!operation.yielded&&!this.suspendedJobs?.has(job.id)&&job.processingRecovery)
          await this.checkpoints?.discard(job).catch(()=>{});
        this.exportOperations.delete(job.id);
        job.performance={elapsedMs:Math.round(performance.now()-operation.started),stages:operation.stages};
        // Timing is diagnostic metadata; it must never mask an export failure
        // (including a call rejected before it has a persisted job id).
        try {
          const row=typeof job.id==='string'?this.store.get('SELECT data FROM jobs WHERE id=?',job.id):null;
          if(typeof row?.data==='string'){const saved=JSON.parse(row.data);saved.performance=job.performance;this.store.run('UPDATE jobs SET data=? WHERE id=?',JSON.stringify(saved),job.id);}
        } catch { /* Shutdown or a removed job can make diagnostics unavailable. */ }
      });
    return operation.done;
  }
  constructor(store, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', exportAcceleration = process.env.EXPORT_ACCELERATION || 'auto', renderBlockSeconds = 60, renderCacheOptions, idleRenderOptions } = {}) { this.store = store; store.exportCheckpoints=this.checkpoints; this.fonts = new DanmakuFonts(store); this.temporaryRoot = path.join(store.root,'temp'); this.temporaryWorkspaces = new TemporaryWorkspaces(this.temporaryRoot); this.publication = new ExportPublication(this.temporaryWorkspaces); this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; this.previews = new Map(); this.enqueues = new Set(); this.probes = new Set(); this.saves = new Map(); this.savePreparations = new Set(); this.retrying = new Set(); this.blockedSessions = new Map(); this.processing = false; this.children = new Set(); this.backgroundChildren = new Set(); this.exportAcceleration = exportAcceleration; this.exportEncoder = null; this.closed = false; this.idlePolicy=new IdleRenderPolicy(idleRenderOptions);this.renderCache=new RenderCache(store.root,renderCacheOptions);this.renderer=new RenderPipeline(this,assText,{blockSeconds:renderBlockSeconds}); }
  prepareNext(id,options={}){
    if(this.closed)return Promise.reject(Object.assign(new Error('后台预处理已停止。'),{name:'AbortError'}));
    if(this.preparationCalls.has(id))return this.preparationCalls.get(id);
    const operation={started:performance.now(),stages:{},live:!!options.live,automatic:!!options.automatic};
    const signal=options.signal?AbortSignal.any([options.signal,this.preparationShutdown.signal]):this.preparationShutdown.signal;
    const task=this.preparationContext.run(operation,()=>Promise.resolve().then(()=>this.renderer.prepareNext(id,{...options,signal})))
      .then(result=>({...result,performance:{elapsedMs:Math.round(performance.now()-operation.started),stages:operation.stages,policy:operation.policy}}))
      .finally(()=>{this.preparationCalls.delete(id);this.preparationMetrics.set(id,{elapsedMs:Math.round(performance.now()-operation.started),stages:operation.stages,policy:operation.policy});while(this.preparationMetrics.size>8)this.preparationMetrics.delete(this.preparationMetrics.keys().next().value);});
    this.preparationCalls.set(id,task);return task;
  }
  async withBackgroundBatch(capacity,work){
    const batch={capacity:Math.max(1,Math.min(2,capacity))};this.backgroundBatches.add(batch);
    try{return await work();}finally{this.backgroundBatches.delete(batch);this.scheduler?.drain();}
  }
  async withForegroundBatch(capacity,work){
    const batch={capacity:Math.max(1,Math.min(4,capacity))};this.foregroundBatches.add(batch);
    try{return await work();}finally{this.foregroundBatches.delete(batch);this.scheduler?.drain();}
  }
  invalidatePreparation(id){this.renderer.invalidate(id);}
  discardPendingPreparation(id){return this.renderCache.dropPending(entry=>!id||entry.spec.sessionId===id);}
  async liveHardwareAvailable(){
    if(this.closed||this.exportAcceleration==='software')return false;
    // The tiny real encoder probe uses the same bounded, low-priority lane.
    // Its result is shared with exports; a listed but unusable GPU is not enough.
    try {
      const operation={started:performance.now(),stages:{},live:true};
      const encoder=await this.preparationContext.run(operation,()=>this.renderer.encoder({background:true,signal:this.preparationShutdown.signal}));
      return !this.closed&&encoder.hardware===true&&['h264_videotoolbox','h264_nvenc','h264_qsv','h264_amf'].includes(encoder.id);
    }catch{return false;}
  }
  // Preview and audio analysis can run beside preparation. Cleanup still uses
  // the default broad check, so their readers/processes remain protected.
  interactiveChildren = new Set();
  hasForegroundWork({includeInteractive=true}={}){return this.processing||this.enqueues.size>0||(includeInteractive&&this.previews.size>0)||[...this.probes].some(probe=>!probe.background)||this.saves.size>0||this.savePreparations.size>0||[...this.children].some(child=>!this.backgroundChildren.has(child)&&(includeInteractive||!this.interactiveChildren.has(child)));}
  assertSessionAvailable(id) {if(this.closed)throw new Error('视频服务已关闭。');if(this.blockedSessions.has(id)||this.store.deletions?.has(id))throw new Error('素材正在删除，请稍后再试。');if(!this.store.session(id))throw new Error('找不到录像，素材不存在或已删除。');}
  async cancelPreviews(id) {
    this.blockedSessions.set(id,(this.blockedSessions.get(id)||0)+1);
    const queued=this.previewRequests?.cancelSession(id);
    const active=[...this.previews.values()].filter(item=>item.sessionId===id);
    for(const item of [...active,...this.probes].filter(item=>item.sessionId===id))item.controller?.abort();
    await Promise.allSettled([queued,...[...active,...[...this.enqueues,...this.probes].filter(item=>item.sessionId===id)].map(item=>item.done)]);
  }
  allowSession(id) {const count=this.blockedSessions.get(id)||0;if(count>1)this.blockedSessions.set(id,count-1);else this.blockedSessions.delete(id);}
  temporaryDirectory(prefix, sessionId) { return this.temporaryWorkspaces.create(prefix, sessionId); }
  cleanupStaleTemporary() { return this.temporaryWorkspaces.cleanupStale(); }
  spawnTracked(executable,args,options,directory) {
    if(this.closed)throw new Error('视频服务已关闭。');
    const ticket=this.temporaryWorkspaces.beforeSpawn(directory);let child;
    try {
      child=spawn(executable,args,options);
      this.temporaryWorkspaces.spawned(ticket,child.pid);
    } catch(error) {
      if(child){child.once('error',()=>{});child.once('close',()=>this.temporaryWorkspaces.childExited(ticket,child.pid));stopChild(child);}
      else if(ticket)try{this.temporaryWorkspaces.spawned(ticket,null);}catch{}
      throw error;
    }
    child.once('close',()=>this.temporaryWorkspaces.childExited(ticket,child.pid));
    return child;
  }
  scheduled(kind,signal,work,stage=kind) {
    if(this.closed)return Promise.reject(new Error('视频服务已关闭。'));
    this.scheduler??=new MediaScheduler({recording:()=>this.isRecording?.()===true,automaticAllowed:()=>this.canStartAutomaticMedia(),
      backgroundLimit:()=>Math.max(1,...[...(this.backgroundBatches||[])].map(batch=>batch.capacity)),
      foregroundLimit:()=>Math.max(2,...[...(this.foregroundBatches||[])].map(batch=>batch.capacity))});
    const operation=this.exportContext?.getStore()||this.preparationContext?.getStore();
    if(kind!=='interactive'&&(operation?.automatic||operation?.job?.autoPost))kind='automatic';
    if(kind==='background'&&operation?.live)kind='live-background';
    return this.scheduler.run(kind,signal,work,({waitMs,workMs})=>{
      if(!operation)return;
      const timings=operation.stages[stage]??={count:0,waitMs:0,workMs:0};
      timings.count++;timings.waitMs+=Math.round(waitMs);timings.workMs+=Math.round(workMs);
    });
  }
  process(args, options={}) {
    const signal=Media.prototype.exportSignal.call(this,options.signal),{background,interactive}=options;
    return this.scheduled(interactive?'interactive':background?'background':'foreground',signal,
      ()=>this.processInternal(args,{...options,signal}),options.stage||'media');
  }
  async processExportVideo(args, options) {
    const index=args.findIndex(arg=>arg==='-vf'||arg==='-filter_complex');
    if(index<0||Buffer.byteLength(args[index+1])<8192)return this.process(args,options);
    // Large graphs exceed the Windows command-line limit even with shallow expressions.
    const file=`filter-${randomUUID()}.txt`,location=path.join(options.cwd,file);
    try{
      await fs.writeFile(location,args[index+1],{flag:'wx'});
      const fromFile=args[index]==='-vf'?'-/filter:v':'-/filter_complex';
      return await this.process([...args.slice(0,index),fromFile,file,...args.slice(index+2)],options);
    }finally{
      await fs.unlink(location).catch(()=>{});
    }
  }
  processInternal(args, { input, output, signal, progress, cwd, background=false, interactive=false, idleMs=120000 } = {}) {
    signal=Media.prototype.exportSignal.call(this,signal);
    const exportSignal=this.exportContext?.getStore()?.controller.signal;
    if(this.closed)return Promise.reject(new Error('视频服务已关闭。'));
    if(signal?.aborted)return Promise.reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));
    const child = this.spawnTracked(this.ffmpeg, ['-hide_banner','-loglevel','warning','-nostdin','-progress','pipe:3','-nostats',...args], { cwd, windowsHide: true, stdio: ['pipe', output ? 'pipe' : 'ignore', 'pipe','pipe'] },cwd);
    this.children.add(child);if(background)this.backgroundChildren.add(child);if(interactive)this.interactiveChildren.add(child); let log = '', diagnosticTail='', expressionFilter, failedEnable=false, expressionMemoryError=false;
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    child.stderr.on('data', bytes => {
      const diagnostic=diagnosticTail+bytes;
      diagnosticTail=diagnostic.slice(-256);
      expressionFilter??=/\[(?:Parsed_)?(overlay|drawbox)(?:_\d+)? @ [^\]\r\n]+\] Error when evaluating the expression/.exec(diagnostic)?.[1];
      failedEnable||=/' for enable(?:\s|$)/.test(diagnostic);
      expressionMemoryError||=diagnostic.includes('Cannot allocate memory');
      log=(log+bytes).slice(-16000);progress?.(log);
    });
    const done = new Promise((resolve, reject) => {
      let spawnError;
      child.once('error',error=>{spawnError=error;});
      child.once('close',code=>{
        this.children.delete(child);this.backgroundChildren.delete(child);this.interactiveChildren.delete(child);
        if(signal?.aborted||code===0)resolve();
        else if(spawnError)reject(spawnError);
        else if(expressionFilter&&failedEnable&&expressionMemoryError)
          reject(Object.assign(new Error('FFmpeg 无法解析叠加效果的时间条件。'),{code:'EXPORT_OVERLAY_EXPRESSION',filter:expressionFilter}));
        else reject(new Error(`视频处理失败 (${code})：${log.slice(-1200)}`));
      });
    });
    const inputStream = input ? Readable.from(input,{objectMode:false,highWaterMark:256*1024}) : null;
    // Mark cancellation as an error on the readable as well as closing stdin.
    // A normal destroy racing its async iterator's final read can leave Node's
    // pipeline waiting for an end event that the destroyed stream cannot emit.
    const abort = () => { inputStream?.destroy(Object.assign(new Error('媒体输入已取消。'),{name:'AbortError',code:'ABORT_ERR'})); child.stdin.destroy(); stopChild(child); }; signal?.addEventListener('abort', abort, { once: true });
    let idleTimer,stalled=false,tail='';const counters=new Map();
    const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>{stalled=true;abort();},idleMs);idleTimer.unref?.();};
    const progressPipe=args.some((value,index)=>value==='-progress'&&args[index+1]==='pipe:2')?child.stderr:child.stdio[3];
    progressPipe?.on('data',bytes=>{tail+=bytes;const lines=tail.split('\n');tail=lines.pop().slice(-1000);for(const line of lines){const match=/^(frame|out_time_us|total_size)=(\d+)$/.exec(line);if(match&&counters.get(match[1])!==match[2]){counters.set(match[1],match[2]);touch();}}});
    touch();
    const inputDone = inputStream ? pipeline(inputStream, child.stdin).catch(e => { if (!['EPIPE','ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE'].includes(e.code) && !signal?.aborted) { stopChild(child); throw e; } }) : (child.stdin.end(), Promise.resolve());
    // A paused native player may stop draining the response. Killing FFmpeg
    // alone cannot release that blocked pipe; cancel both ends before handoff.
    const outputDone = output ? pipeline(child.stdout, output, {signal}).catch(e => { stopChild(child); if (!signal?.aborted) throw e; }) : Promise.resolve();
    if(signal?.aborted)abort();
    // A failed pipe can reject before FFmpeg closes. Do not hand its workspace
    // back to the scheduler or cleanup until every pipe and the child settles.
    return Promise.allSettled([done,inputDone,outputDone]).then(results=>{
      if(exportSignal?.aborted)throw Object.assign(new Error('导出已取消。'),{code:'EXPORT_CANCELLED'});
      if(stalled)throw Object.assign(new Error('媒体处理长时间没有进展，已停止本次任务，可重试。'),{code:'MEDIA_STALLED'});
      const failed=[results[1],results[2],results[0]].find(result=>result.status==='rejected');if(failed)throw failed.reason;
    }).finally(() => {clearTimeout(idleTimer);signal?.removeEventListener('abort', abort);});
  }
  async probe(file,{signal,background=false}={}) {
    signal=this.exportSignal(signal);
    return this.scheduled(background?'background':'foreground',signal,()=>this.probeInternal(file,{signal,background}),'probe');
  }
  async probeAudio(file,{signal}={}) {
    signal=this.exportSignal(signal);
    return this.scheduled('foreground',signal,()=>this.probeInternal(file,{signal,kind:'audio'}),'probe');
  }
  async probePackets(file,{signal}={}) {
    signal=this.exportSignal(signal);
    return this.scheduled('foreground',signal,()=>this.probeInternal(file,{signal,kind:'packets'}),'probe');
  }
  async probeInternal(file,{signal,background=false,kind='video'}={}) {
    signal=this.exportSignal(signal);
    return new Promise((resolve,reject) => {
      if(signal?.aborted)return reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));
      const query=kind==='packets'?['-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,dts_time,flags']:
        ['-show_data_hash','sha256','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_aspect_ratio,profile,level,time_base,extradata_hash,nb_frames,duration,start_time,has_b_frames,sample_rate,channels'];
      const child = this.spawnTracked(this.ffprobe, ['-v','error','-analyzeduration','1000000','-probesize','1000000',...query,'-of','json', file], {windowsHide:true},path.dirname(file));
      let output='',log='',timedOut=false,oversized=false,spawnError;this.children.add(child);if(background)this.backgroundChildren.add(child);
      const abort=()=>stopChild(child);signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data', b => {if(output.length+b.length>8*1024*1024){oversized=true;stopChild(child);}else output+=b;});child.stderr.on('data',b=>log=(log+b).slice(-2000));
      const timeout=setTimeout(()=>{timedOut=true;stopChild(child);},15000);
      child.once('error',e=>{spawnError=e;});
      child.once('close', code => { clearTimeout(timeout);this.children.delete(child);this.backgroundChildren.delete(child);signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));if(oversized)return reject(new Error('媒体索引超过安全读取范围。'));if(timedOut)return reject(new Error('读取视频信息超时，请检查素材文件是否可正常访问。'));if(spawnError)return reject(new Error(`无法启动视频信息读取工具：${spawnError.message}`));if(code)return reject(new Error(`读取视频信息失败：${log.trim()||'工具退出码 '+code}`));try {const data=JSON.parse(output);if(kind==='packets')resolve(data.packets);else if(kind==='audio'){const audio=data.streams?.filter(s=>s.codec_type==='audio');if(audio?.length!==1)throw new Error('需要一条完整音轨。');resolve(audio[0]);}else resolve(videoMetadata(data.streams));}catch(e){reject(e);} });
    });
  }
  requestSourceMetadata(source) {
    this.passiveProbes ??= new Map();
    if (this.closed || !source || this.preparation?.active?.id === source.session) return;
    const preparation = this.preparation?.row(source.session);
    if (['queued','preparing'].includes(preparation?.status)) return;
    const version = JSON.stringify([source.path, source.start, source.closed, source.header]);
    const previous = this.passiveProbes.get(source.id);
    if (previous?.pending || (previous?.version === version && previous.retryAt > Date.now())) return;
    if (this.passiveProbes.size >= 128 && !previous) {
      const oldest = [...this.passiveProbes].find(([, probe]) => !probe.pending);
      if (!oldest) return;
      this.passiveProbes.delete(oldest[0]);
    }
    // A preview/export may be probing the same source already.
    if ([...this.probes].some(probe => probe.sourceId === source.id)) return;
    const probe = { version, pending: true, retryAt: 0 };
    this.passiveProbes.set(source.id, probe);
    void this.probeSource(source, source.start, { background: true }).then(() => {
      this.passiveProbes.delete(source.id);
    }, error => {
      probe.pending = false;
      probe.retryAt = Date.now() + 30000;
      if (error?.name !== 'AbortError') this.store.diagnostics?.record('素材信息',
        `录像 ${source.session}；来源 ${source.id}；探测未完成，30 秒后可重查`, {level:'警告'});
    });
  }
  async probeSource(source,time=source.start,options={}) {
    const controller=new AbortController();
    options={...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal};
    const operation={sessionId:source.session,sourceId:source.id,controller,background:options.background,done:this.probeSourceInternal(source,time,options)};this.probes.add(operation);
    try{return await operation.done;}finally{this.probes.delete(operation);}
  }
  async probeSourceInternal(source,time,options={}) {
    this.assertSessionAvailable(source.session);
    const cached=this.store.setting('metadata:'+source.id);
    if(!options.fresh&&cached?.metadataVersion>=2&&cached.width>0&&cached.height>0&&Number.isFinite(cached.fps)&&cached.fps>0)return cached;
    const dir=await this.temporaryDirectory('bili-probe-',source.session),file=path.join(dir,'sample.flv');
    try{
      const handle=await fs.open(file,'wx');
      try{for await(const bytes of sourceStream(this.store,source.id,time,Math.min(source.start+source.duration,time+5),{signal:options.signal}))await handle.writeFile(bytes);}
      finally{await handle.close();}
      const info=await this.probe(file,options);
      // A historical live range can belong to a different codec epoch. Do not
      // replace the legacy whole-source metadata with a range-specific sample.
      if(!options.fresh&&!this.blockedSessions.has(source.session)&&this.store.session(source.session))this.store.setting('metadata:'+source.id,info);
      return info;
    }catch(e){if(e.code==='ENOENT')throw new Error('内部素材片段缺失，无法读取视频信息。请恢复该素材的内部文件后再导出。');throw e;}
    finally{await this.temporaryWorkspaces.finish(dir);}
  }
  async preview(sessionId, start, response, signal, {client,sequence}={}) {
    if(client)return this.previewRequests.run(client,sequence,sessionId,signal,activeSignal=>this.previewInternal(sessionId,start,response,activeSignal));
    return this.previewInternal(sessionId,start,response,signal);
  }
  async previewInternal(sessionId, start, response, signal) {
    if(signal?.aborted)throw Object.assign(new Error('预览已取消。'),{code:'PREVIEW_CANCELLED',status:409});
    this.assertSessionAvailable(sessionId);
    if(!this.store.session(sessionId))throw new Error('素材不存在或已删除。');
    while(this.previews.size>=3){
      const draining=[...this.previews.values()].filter(item=>item.signal?.aborted||item.controller?.signal?.aborted);
      if(!draining.length)throw new Error('同时预览数量已达上限，请关闭其他预览窗口。');
      // A reload has a new page identity, but its old disconnected producer
      // still must finish. Do not mistake those draining jobs for open windows.
      await (this.previewRequests??=new PreviewRequests()).waitForRelease(Promise.race(draining.map(item=>item.done)),signal||new AbortController().signal);
      this.assertSessionAvailable(sessionId);
      if(signal?.aborted)throw Object.assign(new Error('预览已取消。'),{code:'PREVIEW_CANCELLED',status:409});
    }
    const source = this.store.sources(sessionId).find(s => s.start <= start + .05 && s.start+s.duration >= start-.05);
    if (!source) throw new Error('所选位置暂未录到画面，或处于直播断流区间。');
    const base = seekBase(this.store,source.id,start); if(base===undefined) throw new Error('正在等待关键帧。');
    const token=randomUUID(),controller=new AbortController(),active={sessionId,controller,done:null};
    signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    active.signal=signal;
    this.previews.set(token,active);
    try {
      response.writeHead(200, {'Content-Type':'video/mp4','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      active.done=this.process(['-fflags','+genpts','-probesize','1000000','-analyzeduration','1000000','-f','flv','-i','pipe:0','-ss',String(Math.max(0,start-base)),
        '-t','90','-map','0:v:0','-map','0:a:0?','-vf',"scale=w='min(1280,iw)':h=-2",'-c:v','libx264','-preset','ultrafast','-crf','24','-threads','2','-pix_fmt','yuv420p','-g','30','-bf','0',
        '-c:a','aac','-b:a','128k','-movflags','frag_keyframe+empty_moov+default_base_moof','-flush_packets','1','-f','mp4','pipe:1'],
      {input:sourceStream(this.store,source.id,start,start+90,{follow:true,signal}),output:response,signal,interactive:true});
      await active.done;
    } finally { this.previews.delete(token); }
  }
  async enqueue(id, input, options) {
    const operation={sessionId:id,done:this.enqueueInternal(id,input,options)};this.enqueues.add(operation);
    try{return await operation.done;}finally{this.enqueues.delete(operation);}
  }
  async enqueueInternal(id, input, {autoPost} = {}) {
    this.assertSessionAvailable(id);
    const session=this.store.session(id); if(!session) throw new Error('找不到录像。');
    const scope=input.scope??'clips';if(!['clips','full'].includes(scope))throw new Error('请选择有效的导出范围。');
    const sources=this.store.sources(id);if(scope==='full')this.assertFullReady(session,sources);
    const edit=this.store.edit(id),requested=scope==='full'?[{start:0,end:session.duration}]:input.ranges??edit.ranges;
    if(!Array.isArray(requested)||requested.some(r=>!r||typeof r!=='object'))throw new Error('请选择有效的导出选段。');
    const ranges=validateRanges(requested.filter(r=>r.selected!==false),session.duration);
    if(['includeDanmaku','burn','danmakuFps'].some(key=>key in input))throw new Error('不支持的导出选项，请使用纯净版、弹幕版或双文件模式。');
    const mode=input.mode??'dual';if(!['clean','danmaku','dual'].includes(mode))throw new Error('请选择纯净版、弹幕版或双文件版本。');
    if('giftsEnabled' in input&&typeof input.giftsEnabled!=='boolean')throw new Error('请选择是否在弹幕版显示礼物。');
    const giftStyle=savedGiftStyle(this.store),giftsEnabled=mode!=='clean'&&(input.giftsEnabled??giftStyle.export);
    await this.store.linkmic?.ensure(id);
    const linkmicEvents=this.store.linkmic?.events(id)||[];
    const cameraEvents=this.store.linkmic?.cameraEvents?.(id)||[];
    // Reserve the entire selection before publishing any task. A failed batch
    // must not leave an invisible subset exporting in the background.
    const batchId=randomUUID(),jobs=(scope==='full'?[ranges]:ranges.map(range=>[range])).map((part,index)=>({id:randomUUID(),session:id,ranges:part,excluded:[...edit.excluded],highlighted:[...(edit.highlighted||[])],highlightStyle:savedHighlightStyle(this.store),messageEdits:edit.messageEdits||{},filterLottery:edit.filterLottery!==false,revision:edit.revision,font:this.fonts.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store),mode,scope,batchId,clipIndex:index+1,clipCount:scope==='full'?1:ranges.length}));
    for(const job of jobs) {
      if(autoPost)job.autoPost=autoPost;
      job.linkmicEvents=linkmicEvents.filter(event=>event.participants.length&&job.ranges.some(range=>event.time<range.end&&event.end>range.start));
      job.recordingStyle=savedRecordingStyle(this.store);
      job.cameraEvents=cameraEvents.filter(event=>job.ranges.some(range=>event.time<range.end&&event.end>range.start));
      if(giftsEnabled){
        job.giftStyle={...giftStyle,export:true};
        job.gifts=giftMessages(this.store,id,{from:Math.max(0,job.ranges[0].start-5),to:job.ranges.at(-1).end,limit:20001,style:giftStyle})
          .filter(g=>!job.excluded.includes(g.id)&&job.ranges.some(r=>g.time<r.end&&g.time+5>r.start));
        if(job.gifts.length>20000)throw new Error('所选片段礼物过多，请拆成较短片段导出。');
        job.giftIcons=await this.store.giftIcons?.snapshot(job.gifts)||{};
      }
    }
    try {
      const handoff=this.preparation?.yieldForExport?await this.preparation.yieldForExport(id,jobs):await this.preparation?.yieldForForeground();
      if(handoff)for(const job of jobs)this.preparationHandoffs.set(job.id,handoff);
      const outputRoot=await writableDirectory(input.exportDirectory??directories(this.store).exports);
      for(const job of jobs){
        job.outputRoot=outputRoot;
        this.assertSessionAvailable(id);
        job.output=await this.reserveOutput(job,session,sources);
        Object.assign(job.output,{namingVersion:2,sidecars:false});
        if(mode!=='clean')job.output.danmakuFile=clipFile(job.output.file,'danmaku');
      }
      this.assertSessionAvailable(id);
      if(!this.store.session(id))throw new Error('素材不存在，无法导出。');
      const created=new Date().toISOString();
      this.store.transaction(()=>{
        for(const job of jobs)this.store.run('INSERT INTO jobs(id,session,created,status,data,file,mode) VALUES(?,?,?,?,?,?,?)',job.id,id,created,'queued',JSON.stringify(job),mode==='danmaku'?clipFile(job.output.file,'danmaku'):job.output.file,job.mode);
      });
      void this.work(); return jobs.length===1?jobs[0]:{jobs};
    }catch(error){
      for(const job of jobs){
        const handoff=this.preparationHandoffs?.get(job.id);this.preparationHandoffs?.delete(job.id);await handoff?.release(job.id);
        if(job.output?.reservation)await fs.rmdir(job.output.reservation).catch(()=>{});
        else if(job.output?.dir)await fs.rmdir(job.output.dir).catch(()=>{});
      }
      throw error;
    }
  }
  assertFullReady(session,sources) {
    if(session?.status!=='finished'||!sources.length||sources.some(source=>source.closed!==2))throw new Error('请等待录制结束、素材整理完成后再导出完整素材。');
  }
  async reserveOutput(job,session,sources) {
    const root=exportScopeDirectory(job.outputRoot||directories(this.store).exports,job.scope);
    const span=outputSpan(session,sources,job.ranges);
    return job.scope==='full'?reserveFull(root,span,this.temporaryRoot):reserveClip(root,span);
  }
  canStartAutomaticMedia(){
    return this.automaticMediaAllowed?.()!==false;
  }
  maintainAutomaticExports(){
    if(this.closed)return;
    const queued=!this.processing&&this.store.get("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1");
    if(!queued&&![...this.exportOperations.values()].some(operation=>operation.job.autoPost))return;
    if(this.canStartAutomaticMedia()){
      if(queued)void this.work();
      return;
    }
    for(const [id,operation] of this.exportOperations){
      if(!operation.job.autoPost||operation.controller.signal.aborted||
        this.store.get('SELECT status FROM jobs WHERE id=?',id)?.status!=='running')continue;
      operation.yielded=true;
      operation.controller.abort();
    }
  }
  async work() {
    if(this.processing) return;
    this.processing=true;
    try {
      // Manual exports keep their normal priority. An automatic export that
      // yields to a recorder keeps its row and any verified render checkpoints.
      let job;
      while(!this.closed&&(job=this.store.get(`SELECT *,CASE WHEN json_valid(data) THEN json_extract(data,'$.autoPost') END AS automatic
        FROM jobs WHERE status='queued' AND (? OR automatic IS NULL)
        ORDER BY automatic IS NOT NULL,created,rowid LIMIT 1`,+this.canStartAutomaticMedia()))) {
        this.store.run("UPDATE jobs SET status='running',progress=.01 WHERE id=?",job.id);
        let details;
        try{details=JSON.parse(job.data);await this.exportJob(details);}
        catch(error){
          const suspended=this.suspendedJobs?.has(job.id),status=this.store.get('SELECT status FROM jobs WHERE id=?',job.id)?.status;
          const yielded=!suspended&&status==='running'&&error.automaticYield===true&&!error.savePending;
          const cancelled=error.code==='EXPORT_CANCELLED'||status==='cancelling';
          if(details){if(suspended)details.resumeOnLaunch=true;else delete details.resumeOnLaunch;}
          this.store.run("UPDATE jobs SET status=?,error=?,data=? WHERE id=?",
            suspended?'interrupted':yielded?'queued':cancelled?'cancelled':error.savePending?'save_failed':'failed',
            suspended||yielded||cancelled?'':error.message,details===undefined?job.data:JSON.stringify(details),job.id);
          if(yielded)break;
        }
      }
    } finally {this.processing=false;}
  }
  async recoverPendingSaves() {
    for(const row of this.store.all("SELECT id,data FROM jobs WHERE status IN ('failed','saving','save_failed','finalizing','running','interrupted')")) {
      if(this.closed)break;
      const job=this.store.jobDetails(row);if(job.recoveryInvalid)continue;
      try {
      const pending=await this.publication.recoverStage(job);
      if(this.closed)break;
      if(!pending) {
        if(await this.publication.verifyPublished(job)&&!this.closed)this.completeSave(job);
        continue;
      }
      job.pendingPublication=pending;job.canRetrySave=true;
      this.store.run("UPDATE jobs SET status='save_failed',progress=.98,data=?,error=? WHERE id=?",JSON.stringify(job),'视频已处理完成，请重试保存。',row.id);
      }catch(error){if(!this.closed){
        let retry=false;try{retry=(await this.publication.recoveryIntent(job.pendingPublication?.directory||job.processingRecovery?.directory,row.id))?.phase==='staging';}catch{}
        job.canRetrySave=retry;
        this.store.run('UPDATE jobs SET status=?,data=?,error=? WHERE id=?',retry?'save_failed':'failed',JSON.stringify(job),'恢复未完成，暂存文件已保留：'+error.message,row.id);
        this.store.diagnostics?.record('任务恢复',error,{level:'警告'});
      }}
    }
  }
  suspendForExit(){
    const suspended=[];
    this.store.transaction(()=>{
      for(const row of this.store.all("SELECT * FROM jobs WHERE status IN ('queued','running','finalizing','saving','save_failed')")){
        if(row.status==='save_failed'&&!this.retrying.has(row.id))continue;
        const job={...(this.exportOperations.get(row.id)?.job??JSON.parse(row.data)),resumeOnLaunch:true};
        suspended.push(row.id);
        this.store.run("UPDATE jobs SET status='interrupted',error='',data=? WHERE id=?",JSON.stringify(job),row.id);
      }
    });
    this.closed=true;this.suspendedJobs??=new Set();
    for(const id of suspended){this.suspendedJobs.add(id);const operation=this.exportOperations.get(id);if(operation)operation.job.resumeOnLaunch=true;}
    for(const operation of this.exportOperations.values())operation.controller.abort();
    this.close();
  }
  async recoverInterruptedExports(){
    for(const row of this.store.all("SELECT * FROM jobs WHERE status IN ('interrupted','save_failed') OR (status='failed' AND data LIKE '%processingRecovery%')")){
      if(this.closed)break;
      const job=this.store.jobDetails(row);
      if(job.recoveryInvalid)continue;
      if(job.resumeOnLaunch!==true)continue;
      if((job.recoveryAttempts||0)>=3){delete job.resumeOnLaunch;this.store.run("UPDATE jobs SET status='failed',error='导出已多次异常中断，请检查设备与磁盘后点击继续导出。',data=? WHERE id=?",JSON.stringify(job),row.id);continue;}
      if(!this.store.session(job.session)){
        delete job.resumeOnLaunch;
        this.store.run("UPDATE jobs SET status='failed',error='素材不存在，无法恢复导出。',data=? WHERE id=?",JSON.stringify(job),row.id);continue;
      }
      if(row.status==='save_failed'){
        try{await this.retrySave(row.id);}catch(error){delete job.resumeOnLaunch;this.store.run("UPDATE jobs SET data=?,error=? WHERE id=?",JSON.stringify(job),error.message,row.id);}continue;
      }
      try{
        job.recoveryAttempts=(job.recoveryAttempts||0)+1;
        const occupied=async file=>{try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
        if(job.scope==='full'||!job.output||await occupied(job.output.file)||job.output.danmakuFile&&await occupied(job.output.danmakuFile)){
          await this.releaseReservation(job);
          job.output=await this.reserveOutput(job,this.store.session(job.session),this.store.sources(job.session));
          Object.assign(job.output,{namingVersion:2,sidecars:false});
          if(job.mode!=='clean')job.output.danmakuFile=clipFile(job.output.file,'danmaku');
        }
        if(this.closed)break;
        this.store.run("UPDATE jobs SET status='queued',progress=0,error='',data=?,file=? WHERE id=?",JSON.stringify(job),job.mode==='danmaku'?job.output.danmakuFile:job.output.file,row.id);
      }catch(error){if(this.closed)break;delete job.resumeOnLaunch;this.store.run("UPDATE jobs SET status='failed',error=?,data=? WHERE id=?",error.message,JSON.stringify(job),row.id);}
    }
  }
  async retrySave(id,input={}) {
    const operation=this.retrySaveInternal(id,input);this.savePreparations.add(operation);
    try{return await operation;}finally{this.savePreparations.delete(operation);}
  }
  async retryExport(id){
    if(this.closed)throw new Error('视频服务已关闭。');
    if(this.store.deletingJobs?.has(id))throw new Error('该任务正在删除，请等待完成。');
    const row=this.store.get('SELECT * FROM jobs WHERE id=?',id);
    if(!row||!['failed','interrupted','save_failed'].includes(row.status)||this.exportOperations.has(id)||this.retrying.has(id)||this.saves.has(id))throw new Error('该任务当前不能重试导出。');
    const job=this.store.jobDetails(row);if(job.recoveryInvalid)throw new Error('任务记录损坏，请重新创建导出。');
    this.assertSessionAvailable(job.session);
    const pending=await this.publication.recoverStage(job);
    const stageMissing=row.status==='save_failed'&&pending&&await this.publication.stageFilesMissing(job,pending);
    // Recheck after async filesystem validation: a second request may already
    // have claimed this job, or a deletion may have removed the material.
    this.assertSessionAvailable(job.session);
    if(this.store.deletingJobs?.has(id))throw new Error('该任务正在删除，请等待完成。');
    if(!['failed','interrupted','save_failed'].includes(this.store.get('SELECT status FROM jobs WHERE id=?',id)?.status))throw new Error('任务已开始恢复，请等待完成。');
    if (this.retrying.has(id)||this.saves.has(id)||this.store.get('SELECT data FROM jobs WHERE id=?',id)?.data!==row.data) throw new Error('任务已开始恢复，请等待完成。');
    if(pending&&!stageMissing){job.pendingPublication=pending;job.canRetrySave=true;this.store.run("UPDATE jobs SET status='save_failed',data=?,error='成片已完成，请重试保存。' WHERE id=?",JSON.stringify(job),id);return {ok:true,status:'save_failed'};}
    if (row.status==='save_failed') {
      if (await this.publication.verifyPublished(job)) {
        if (this.store.get('SELECT data FROM jobs WHERE id=?',id)?.data!==row.data || this.retrying.has(id)||this.saves.has(id)) throw new Error('任务已开始恢复，请等待完成。');
        this.completeSave(job);
        return {ok:true,status:'done'};
      }
      await this.publication.assertRecoveryStorage(job);
      // Preserve staged folders unless their manifest proves the files are gone.
      for (const directory of new Set([job.pendingPublication?.directory,job.processingRecovery?.directory].filter(Boolean))) {
        if(stageMissing&&directory===pending.directory)continue;
        try { await this.publication.checkDirectory(directory); }
        catch(error) { if(error.code==='ENOENT') continue; throw error; }
        throw new Error('暂存目录仍在，已保留其中的文件，请检查后再试。');
      }
      this.assertSessionAvailable(job.session);
      const sources=this.store.sources(job.session);
      if(!sources.length)throw new Error('原素材不可用，无法重新导出。');
      // A readable original or current storage mapping must still exist.
      for(const source of sources) {
        const files=source.closed===2?[source.path,...this.store.all('SELECT path FROM chunks WHERE source=?',source.id).map(item=>item.path)]:[source.path];
        let readable=false;
        for(const file of files){
          try { await fs.access(file); readable=true; break; }
          catch(error) { if(error.code!=='ENOENT')throw error; }
        }
        if(!readable)throw new Error('原素材不可用，无法重新导出。');
      }
      const next=await this.reserveOutput(job,this.store.session(job.session),sources);
      const current=this.store.get('SELECT status,data FROM jobs WHERE id=?',id);
      if(this.closed||this.store.deletingJobs?.has(id)||this.retrying.has(id)||this.saves.has(id)||current?.status!==row.status||current.data!==row.data){
        await this.releaseReservation({...job,output:next});
        throw new Error('任务已开始恢复，请等待完成。');
      }
      job.output={...next,namingVersion:2,sidecars:false};
      if(job.mode!=='clean')job.output.danmakuFile=clipFile(job.output.file,'danmaku');
      delete job.pendingPublication;
      delete job.processingRecovery;
      delete job.publishedFiles;
      delete job.canRetrySave;
    }
    job.recoveryAttempts=0;job.automaticRetries=0;job.resumeOnLaunch=true;job.resumedExportSteps=0;
    this.store.run("UPDATE jobs SET status='queued',error='',progress=0,data=?,file=? WHERE id=?",JSON.stringify(job),job.mode==='danmaku'?job.output?.danmakuFile||row.file:job.output?.file||row.file,id);
    void this.work();return {ok:true,status:'queued'};
  }
  async retrySaveInternal(id,input={}) {
    if(this.closed)throw new Error('视频服务已关闭。');
    if(this.store.deletingJobs?.has(id)||this.retrying.has(id)||this.saves.has(id))throw new Error('这个任务正在处理，请稍候。');
    const row=this.store.get('SELECT * FROM jobs WHERE id=?',id);
    if(!row||row.status!=='save_failed')throw new Error('这个任务没有可以重试保存的视频。');
    const job=JSON.parse(row.data);this.assertSessionAvailable(job.session);
    if(!this.store.session(job.session))throw new Error('素材不存在或已删除。');
    this.retrying.add(id);
    let newReservation;
    try {
      const pending=await this.publication.recoverStage(job);
      if(this.closed)throw new Error('视频服务已关闭。');
      if(!pending) {
        if(await this.publication.verifyPublished(job)) {
          const file=this.completeSave(job);
          return {...row,status:'done',file,progress:1,data:JSON.stringify(job)};
        }
        throw new Error('已处理的视频不存在或已发生变化，无法重试保存。');
      }
      if(input.exportDirectory!==undefined) {
        const next=await writableDirectory(input.exportDirectory);
        if(this.closed)throw new Error('视频服务已关闭。');
        const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
        if(key(next)!==key(job.outputRoot)) {
          job.outputRoot=next;
          job.output=await this.reserveOutput(job,this.store.session(job.session),this.store.sources(job.session));
          newReservation=job.output.reservation;
          Object.assign(job.output,{namingVersion:2,sidecars:false});
          if(['danmaku','dual'].includes(job.mode))job.output.danmakuFile=clipFile(job.output.file,'danmaku');
        }
      }
      this.assertSessionAvailable(job.session);
      if(this.closed)throw new Error('视频服务已关闭。');
      job.pendingPublication=pending;job.canRetrySave=true;
      this.store.run("UPDATE jobs SET status='saving',data=?,error='',progress=.98 WHERE id=?",JSON.stringify(job),id);
      const done=Promise.resolve().then(async()=>{
        try {
          await this.publishEncoded(job,pending.directory);
        }catch(error) {
          this.store.run("UPDATE jobs SET status='save_failed',error=? WHERE id=?",error.message,id);
        }finally {
          this.saves.delete(id);
          await this.releaseReservation(job);
        }
      });
      this.saves.set(id,done);
      return {...row,status:'saving',data:JSON.stringify(job)};
    }catch(error){
      if(newReservation)await this.releaseReservation(job);
      throw error;
    }finally{this.retrying.delete(id);}
  }
  async waitForSaves() {
    while(this.savePreparations.size||this.saves.size)await Promise.allSettled([...this.savePreparations,...this.saves.values()]);
  }
  async releaseReservation(job) {
    const reservation=job.output?.reservation;
    if(reservation&&path.dirname(reservation)===this.temporaryRoot&&path.basename(reservation).startsWith('bili-full-'))await fs.rmdir(reservation).catch(()=>{});
  }
  async publishEncoded(job,directory) {
    const started=performance.now(),operation=this.exportContext?.getStore();
    try {
      const result=await this.publication.publish(job.id,directory,{outputRoot:job.outputRoot,output:job.output});
      job.publishedFiles=result.publishedFiles;
      if(this.suspendedJobs?.has(job.id))job.resumeOnLaunch=true;
      this.store.run('UPDATE jobs SET data=?,file=? WHERE id=?',JSON.stringify(job),result.file,job.id);
      await this.publication.commit(job.id,directory,result.publishedFiles);
      return this.completeSave(job,result.file);
    }catch(error){error.savePending=true;error.directory=directory;throw error;}
    finally {if(operation){const stage=operation.stages.save??={count:0,waitMs:0,workMs:0};stage.count++;stage.workMs+=Math.round(performance.now()-started);}}
  }
  completeSave(job,file=job.mode==='danmaku'?clipFile(job.output.file,'danmaku'):job.output.file) {
    delete job.pendingPublication;delete job.resumeOnLaunch;delete job.processingRecovery;job.canRetrySave=false;
    this.store.run("UPDATE jobs SET status='done',progress=1,error='',data=?,file=? WHERE id=?",JSON.stringify(job),file,job.id);
    this.preparation?.wake();
    return file;
  }
  async publishFiles(job,workDir,results) {
    this.assertExportActive();
    await this.temporaryWorkspaces.retain(workDir,job.id);
    job.pendingPublication={directory:workDir,jobId:job.id,state:'staging'};job.canRetrySave=true;
    this.persistExportJob(job);
    this.store.run("UPDATE jobs SET status='saving',progress=.98 WHERE id=?",job.id);
    try{
      job.pendingPublication=await this.retryMedia(()=>this.publication.stage(job,workDir,results));
      this.store.run("UPDATE jobs SET status='saving',progress=.98,data=? WHERE id=?",JSON.stringify(job),job.id);
      return await this.publishEncoded(job,workDir);
    }catch(error){error.savePending=true;error.directory=workDir;throw error;}
  }
  async selectExportEncoder() {
    this.exportEncoder??=this.exportAcceleration==='software'?Promise.resolve(softwareEncoder()):detectExportEncoder((args,options)=>this.process(args,options));
    return this.exportEncoder;
  }
  async performExportJob(job) {
    try {
    if(this.closed)throw new Error('视频服务已关闭。');
    this.assertSessionAvailable(job.session);
    const handoff=this.preparationHandoffs?.get(job.id);
    if(handoff){
      const signal=this.exportSignal();
      await new Promise((resolve,reject)=>{
        const abort=()=>reject(Object.assign(new Error('导出已取消。'),{code:'EXPORT_CANCELLED'}));
        signal?.addEventListener('abort',abort,{once:true});
        Promise.resolve(handoff.done).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));
        if(signal?.aborted)abort();
      });
      this.assertExportActive();job.preparationHandoff=true;
    }
    job.scope??='clips';if(!['clips','full'].includes(job.scope))throw new Error('导出范围无效。');
    job.outputRoot??=directories(this.store).exports;
    if(job.scope==='full') {
      const session=this.store.session(job.session);this.assertFullReady(session,this.store.sources(job.session));
      job.ranges=validateRanges([{start:0,end:session.duration}],session.duration);
    }
    if(!['clean','danmaku','dual'].includes(job.mode))throw new Error('导出版本无效，请重新创建导出任务。');
    const sources=this.store.sources(job.session);
    const first=sources.find(s=>s.start<job.ranges[0].end&&s.start+s.duration>job.ranges[0].start);
    if(!first)throw new Error('选段中没有已录制的画面。');
    const info=await this.probeSource(first,Math.max(first.start,job.ranges[0].start));
    const sourcePlan=await sourceExportPlan(this,job,sources,info);
    const copyClean=sourcePlan.canCopyOriginal;
    if(job.scope==='full'&&job.mode==='clean'){
      job.cleanStreamCopy=false;
      job.cleanStreamCopyEligible=copyClean;
      if(!copyClean)job.cleanEncodingReason=sourcePlan.reason;
    }
    const cleanOnly=job.mode==='clean';
    // Older versions may already have finished an entire regular-path source.
    // Finish that existing job without discarding its validated large files.
    const legacyRecovery=job.processingRecovery?.route==='regular-v1';
    let encoder;
    if(copyClean&&cleanOnly||job.processingRecovery?.route===CPU_EXPORT_ROUTE||legacyRecovery&&job.encoder==='libx264')encoder=softwareEncoder();
    else {
      encoder=await this.selectExportEncoder();
    }
    if(this.closed)throw new Error('视频服务已关闭。');
    const recordEncoder=()=>{job.encoder=encoder.id;job.encoderLabel=encoder.label;this.store.run('UPDATE jobs SET data=? WHERE id=?',JSON.stringify(job),job.id);};
    recordEncoder();
    let file;
    if(job.gifts?.length){
      // Gift exports use their frozen event/artwork snapshot. Existing prepared
      // chat-only blocks remain available and cannot hide an opted-in gift.
      try{return await this.encodeJob(job,encoder,{first,info,copyClean,sourcePlan});}
      catch(error){if(!encoder.hardware||!error.hardwareEncoderFailure||error.savePending)throw error;
        encoder=softwareEncoder();recordEncoder();return await this.encodeJob(job,encoder,{first,info,copyClean,sourcePlan});}
    }
    const selectedDuration=sourcePlan.segments.reduce((sum,segment)=>sum+segment.to-segment.from,0);
    const finished=this.store.session(job.session)?.status==='finished'&&sources.every(source=>source.closed===2);
    const cpuCheckpointed=()=>!legacyRecovery&&!encoder.hardware&&finished&&(selectedDuration>=CPU_CHECKPOINT_SECONDS||job.processingRecovery?.route===CPU_EXPORT_ROUTE);
    const exportCpu=async(plan=sourcePlan)=>{
      job.output??=await this.reserveOutput(job,this.store.session(job.session),sources);
      Object.assign(job.output,{namingVersion:2,sidecars:false});
      return this.renderer.exportJob(job,encoder,plan,{cpuCheckpoints:true});
    };
    const immediateParallel=encoder.hardware&&selectedDuration>=60;
    const prepared=!legacyRecovery&&!cleanOnly&&finished&&(immediateParallel||job.processingRecovery?.route==='prepared-v9'||await this.renderCache.hasReady(job.session));
    // Keep existing prepared blocks when available. A cold CPU export gets its
    // regular foreground budget and persists each minute independently instead
    // of silently returning to a whole-source encode after a failed block.
    if(cpuCheckpointed()&&(job.processingRecovery?.route===CPU_EXPORT_ROUTE||!prepared&&!(copyClean&&cleanOnly)))return await exportCpu();
    if(prepared) {
      try {
        job.output??=await this.reserveOutput(job,this.store.session(job.session),sources);
        Object.assign(job.output,{namingVersion:2,sidecars:false});
        return await this.renderer.exportJob(job,encoder,sourcePlan);
      }catch(error) {
        this.assertExportActive();
        if(error.savePending||this.closed||['action','temporary'].includes(mediaFailure(error)))throw error;
        // Missing, changed or incompatible cache is only an optimization miss.
        // A publication failure must keep its finished video and never re-encode.
        job.preparationFallback=error.message;
        if(encoder.hardware&&error.hardwareEncoderFailure) {
          encoder=softwareEncoder();this.exportEncoder=Promise.resolve(encoder);
          job.encoderFallback=true;recordEncoder();
        }
      }
    }
    if(cpuCheckpointed()&&!(copyClean&&cleanOnly))return await exportCpu();
    try { file=await this.encodeJob(job,encoder,{first,info,copyClean,sourcePlan}); }
    catch(e) {
      this.assertExportActive();
      if(['action','temporary'].includes(mediaFailure(e)))throw e;
      if(e.originalCopyFailure&&!e.savePending&&!this.closed){
        job.streamCopyFallback=true;job.cleanStreamCopy=false;job.cleanEncodingReason=e.message;
        encoder=await this.selectExportEncoder();recordEncoder();
        if(cpuCheckpointed())return await exportCpu({...sourcePlan,canCopyOriginal:false,canCopyStreams:false});
        try{file=await this.encodeJob(job,encoder,{first,info,disableStreamCopy:true});}
        catch(retry){if(!encoder.hardware||!retry.hardwareEncoderFailure||retry.savePending)throw retry;encoder=softwareEncoder();this.exportEncoder=Promise.resolve(encoder);job.encoderFallback=true;recordEncoder();
          if(cpuCheckpointed())return await exportCpu({...sourcePlan,canCopyOriginal:false,canCopyStreams:false});
          file=await this.encodeJob(job,encoder,{first,info,disableStreamCopy:true});}
        return file;
      }
      if(this.closed||!encoder.hardware||!e.hardwareEncoderFailure)throw e;
      // Rebuild every part with the same software encoder. Mixing partially
      // completed GPU and CPU parts can make the final concatenation unreliable.
      encoder=softwareEncoder();this.exportEncoder=Promise.resolve(encoder);
      job.encoderFallback=true;recordEncoder();
      if(cpuCheckpointed()&&!(copyClean&&cleanOnly))return await exportCpu();
      file=await this.encodeJob(job,encoder,{first,info,copyClean,sourcePlan});
    }
    return file;
    } finally {
      await this.releaseReservation(job);
    }
  }
  async encodeJob(job,encoder,prepared={}) {
    if(job.autoPost&&!encoder.hardware)encoder={...encoder,threads:Math.min(2,encoder.threads)};
    if(!this.store.session(job.session))throw new Error('素材不存在或已删除。');
    const sources=this.store.sources(job.session), excluded=new Set(job.excluded), parts=[];
    const dual=job.mode==='dual',bakedOnly=job.mode==='danmaku';
    job.output??=await this.reserveOutput(job,this.store.session(job.session),sources);
    Object.assign(job.output,{namingVersion:2,sidecars:false});
    if(dual||bakedOnly)job.output.danmakuFile=clipFile(job.output.file,'danmaku');
    else delete job.output.danmakuFile;
    const output=bakedOnly?clipFile(job.output.file,'danmaku'):job.output.file;
    const segments=prepared.sourcePlan?.segments??exportSegments(sources,job.ranges,job.scope);
    const first=segments[0]?.source;if(!first)throw new Error('选段中没有已录制的画面。');
    const info=prepared.first?.id===first.id?prepared.info:await this.probeSource(first,segments[0].from);
    const width=Math.max(2,Math.floor(info.width/2)*2),height=Math.max(2,Math.floor(info.height/2)*2);
    const layoutFont=job.font?.id?await this.fonts.selection(job.font.id):job.font;
    const chatLayout=dual||bakedOnly?await this.renderer.layout(job.session,undefined,job.danmakuPerSecond??chatRate(this.store),{width,height,style:job.danmakuStyle,font:layoutFont,highlightStyle:job.highlightStyle,highlighted:job.highlighted||[],messageEdits:job.messageEdits||{}}):null;
    const checkpoint=await this.exportWorkspace(job,{route:'regular-v1',encoder,profile:[width,height,!!prepared.disableStreamCopy,...(bakedOnly||dual?[danmakuAssSize(1,layoutFont)]:[])],comments:commentSignature(chatLayout||[]),segments});
    const workDir=checkpoint.directory;
    try {
    if(job.mode==='clean'&&prepared.sourcePlan?.canCopyOriginal&&(segments.length>1||prepared.sourcePlan.entries[0].wholeFromSource)){
      await checkpoint.run('original',()=>copyOriginal(this,prepared.sourcePlan,workDir),['final.mp4']);
      job.cleanStreamCopy=true;job.audioStreamCopy=prepared.sourcePlan.entries[0].info.audioStreams===1;
      return await this.publishFiles(job,workDir,[{temporary:'final.mp4',file:output}]);
    }
    const fontDirectory=await this.fonts.stage(job.font,workDir);
    let outputOffset=0;
    const totalDuration=segments.reduce((sum,segment)=>sum+segment.to-segment.from,0),singlePart=segments.length===1;
    for(const {source,from,to} of segments) {
      const number=parts.length,out=singlePart?'final.mp4':`part-${number}.mp4`;
      const bakedOut=singlePart?'final-danmaku.mp4':`part-${number}-danmaku.mp4`;
      const sourceInfo=source.id===first.id?info:await this.probeSource(source,from);
      const base=seekBase(this.store,source.id,from);
      if(base===undefined)throw new Error('选段没有可用关键帧。');
      const fps=normalizedDanmakuStyle(job.danmakuStyle).fps;
      const labels=(job.linkmicEvents||[]).filter(event=>event.source===source.id&&event.participants.length&&event.time<to&&event.end>from);
      const compatibleFull=!prepared.disableStreamCopy&&(prepared.sourcePlan?.canCopyStreams??true)&&singlePart&&canCopyFullSource(job,sources,sourceInfo,base);
      let copyClean=!bakedOnly&&!labels.length&&compatibleFull&&(prepared.sourcePlan?.canCopyOriginal??true);
      let copyAudio=compatibleFull&&sourceInfo.audioStreams===1&&sourceInfo.audioCodec==='aac'&&!job.audioStreamCopyFallback;
      const splitKey=hashRender([source.id,from,to]);
      const frameCount=(start,end,rate)=>Math.round((end-from)*rate)-Math.round((start-from)*rate);
      let lastProgress=0;
      const renderRange=async({from:start,to:end,out,bakedOut,videoOnly=false,stem})=>{
        const base=seekBase(this.store,source.id,start);
        if(base===undefined)throw new Error('选段没有可用关键帧。');
        const subFile=`${stem}.ass`,labelFile=`names-${stem}.ass`;
        const shownLabels=labels.filter(event=>event.time<end&&event.end>start);
        if(dual||bakedOnly) {
          const messages=visibleComments(chatLayout,{excluded,filterLottery:job.filterLottery!==false},start,end);
          // ASS uses the input clock, which starts at the preceding keyframe.
          await fs.writeFile(path.join(workDir,subFile),assText(messages.map(m=>({...m,time:m.time-base,end:m.end-base})),width,height,layoutFont,job.danmakuStyle)+giftAss(job.gifts||[],width,height,{base,from:start,to:end}));
        }
        const cameraEvents=blockCameraEvents(job.cameraEvents,source.id,start,end);
        const filter=recordingLayoutFilter(cameraEvents,job.recordingStyle??originalRecordingStyle(),width,height,
          {sourceWidth:sourceInfo.width,sourceHeight:sourceInfo.height,base,from:start,to:end,fallback:videoGeometryFilter(sourceInfo,width,height)||'null'});
        const cardOptions={base,from:start,to:end,sourceWidth:sourceInfo.width,sourceHeight:sourceInfo.height};
        if(shownLabels.length)await fs.writeFile(path.join(workDir,labelFile),linkmicAss(shownLabels,width,height,cardOptions));
        const withNames=async prefix=>[await avatarFilter(this.store,shownLabels,width,height,workDir,{...cardOptions,prefix}),shownLabels.length?`ass=${labelFile}`:''].filter(Boolean).join(',');
        const labelFilter=await withNames('cleanmic'),danmakuLabelFilter=dual?await withNames('danmic'):labelFilter;
        const giftFilter=await giftIconFilter(job.gifts||[],job.giftIcons,width,height,workDir,{base,from:start,to:end});
        const padding=videoOnly?',tpad=stop_mode=clone:stop_duration=0.2':'';
        const overlayFilter=`fps=${fps},ass=${subFile}${fontDirectory?':fontsdir='+fontDirectory:''}`+(giftFilter?','+giftFilter:'');
        const mux=singlePart&&!videoOnly?['-movflags','+faststart']:[];
        const audio=videoOnly?['-an']:['-map','0:a:0?',...(copyAudio?['-c:a','copy']:['-c:a','aac','-b:a','192k'])];
        const encode=(map,file,baked=false)=>{
          const rate=baked?fps:info.fps;
          const limit=videoOnly?['-frames:v',String(frameCount(start,end,rate))]:['-t',String(end-start)];
          return ['-ss',String(Math.max(0,start-base)),...limit,'-map',map,
            ...encoderArguments(encoder,dual&&!copyClean),'-pix_fmt','yuv420p','-r',String(rate),...audio,...mux,'-y',file];
        };
        const copied=file=>['-t',String(end-start),'-map','0:v:0','-map','0:a:0?',
          ...(job.audioStreamCopyFallback?['-c:v','copy','-c:a','aac','-b:a','192k']:['-c','copy']),...mux,'-y',file];
        let filters=[],outputs;
        if(dual) {
          const bakedFilter=[overlayFilter,danmakuLabelFilter].filter(Boolean).join(',')+padding;
          const cleanFilter=(labelFilter||'null')+padding;
          const split=labelFilter||videoOnly
            ?`split=2[plain][overlay];[plain]${cleanFilter}[clean];[overlay]${bakedFilter}[danmaku]`
            :`split=2[clean][overlay];[overlay]${bakedFilter}[danmaku]`;
          const graph=copyClean?`[0:v:0]${overlayFilter}[danmaku]`:`[0:v:0]${filter?filter+',':''}${split}`;
          filters=['-filter_complex_threads','2','-filter_complex',graph];
          outputs=[...(copyClean?copied(out):encode('[clean]',out)),...encode('[danmaku]',bakedOut,true)];
        } else if(copyClean)outputs=copied(out);
        else {
          const chain=[filter,...(bakedOnly?[overlayFilter]:[]),labelFilter].filter(Boolean).join(',');
          if(chain||videoOnly)filters=['-filter_threads','2','-vf',(chain||'null')+padding];
          outputs=encode('0:v:0',out,bakedOnly);
        }
        try{
          await this.processExportVideo(['-stats_period','1','-progress','pipe:2','-nostats','-fflags','+genpts','-threads','2','-f','flv','-i','pipe:0',...filters,...outputs],
            {cwd:workDir,input:sourceStream(this.store,source.id,start,end),stage:copyClean&&job.mode==='clean'?'copy':'render',progress:log=>{
              if(this.closed)return;
              const matches=[...log.matchAll(/(?:^|\n)out_time_us=(\d+)/g)],seconds=Number(matches.at(-1)?.[1])/1000000;
              if(!Number.isFinite(seconds)||Date.now()-lastProgress<750)return;
              lastProgress=Date.now();
              const progress=outputOffset+(start-from)+Math.max(0,Math.min(end-start,seconds));
              this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.94,.01+.93*progress/totalDuration),job.id);
            }});
        }catch(error){
          if(error.code==='EXPORT_OVERLAY_EXPRESSION'){
            const layers=error.filter==='drawbox'?['连麦头像']:[
              ...(filter?.includes("enable=")?['摄像头布局']:[]),
              ...(labelFilter.includes("enable=")?['连麦头像']:[]),
              ...(giftFilter?['礼物图标']:[])
            ];
            error.message=`录像 ${start.toFixed(3)}–${end.toFixed(3)} 秒，${layers.join('、')||error.filter||'画面叠加'}的时间条件无法处理。`;
          }
          throw error;
        }
      };
      const renderWhole=()=>renderRange({from,to,out,bakedOut,stem:`part-${number}`});
      const renderWithAudioFallback=async()=>{
        try{await renderWhole();}catch(error){
          if(this.closed||!copyAudio||!/(?:malformed AAC bitstream|AAC bitstream[^\r\n]*(?:ADTS|extradata)|could not find tag for codec aac)/i.test(error.message))throw error;
          copyAudio=false;job.audioStreamCopyFallback=true;await renderWhole();
        }
      };
      const overlayFailure=error=>['EXPORT_OVERLAY_EXPRESSION','CAMERA_LAYOUT_COMPLEX'].includes(error.code);
      const renderSplit=async()=>{
        copyClean=false;copyAudio=false;job.cleanStreamCopy=false;
        const files=[],bakedFiles=[],failedBlocks=new Set(job.overlaySplitParts?.[splitKey]||[]);
        const splitBlock=async(start,end,block)=>{
          this.assertExportActive();
          const stem=`part-${number}-block-${block}`,file=stem+'.mp4',baked=stem+'-danmaku.mp4';
          if(!failedBlocks.has(block))try{
            await checkpoint.run(stem,()=>renderRange({from:start,to:end,out:file,bakedOut:baked,videoOnly:true,stem}),dual?[file,baked]:[file]);
            const rate=bakedOnly?fps:info.fps;
            files.push({file:path.join(workDir,file),duration:frameCount(start,end,rate)/rate});
            if(dual)bakedFiles.push({file:path.join(workDir,baked),duration:frameCount(start,end,fps)/fps});
            return;
          }catch(error){
            this.assertExportActive();
            if(!overlayFailure(error)||this.closed||end-start<=2||block.split('-').length>=7)throw error;
            failedBlocks.add(block);
            job.overlaySplitParts[splitKey]=[...failedBlocks];this.persistExportJob(job);
          }
          const cut=start+Math.max(1,Math.floor((end-start)/2));
          await splitBlock(start,cut,block+'-0');
          await splitBlock(cut,end,block+'-1');
        };
        const length=to-from,step=length>60?60:Math.max(1,Math.floor(length/2));
        for(let block=0;;block++){
          const start=from+block*step,next=start+step;
          const end=to-next<1?to:next;
          await splitBlock(start,end,String(block));
          if(end===to)break;
        }
        // Encode the parent span's audio once. Per-block AAC would round and
        // introduce encoder delay at every splice.
        const audio=await this.renderer.audio([{source,from,to}],{sources:[source],info:sourceInfo,profile:{fps:bakedOnly?fps:info.fps},sourceExport:{canCopyStreams:false}},workDir,job);
        await this.renderer.mux(files,audio,out,workDir,`split-${number}.txt`);
        if(dual)await this.renderer.mux(bakedFiles,audio,bakedOut,workDir,`split-${number}-danmaku.txt`);
      };
      const wasSplit=Object.hasOwn(job.overlaySplitParts||{},splitKey);
      if(wasSplit){copyClean=false;copyAudio=false;}
      await checkpoint.run('part-'+number,async()=>{
        if(wasSplit)return renderSplit();
        try {await renderWithAudioFallback();}
        catch(error) {
          this.assertExportActive();
          if(this.closed||mediaFailure(error)==='action'||mediaFailure(error)==='temporary')throw error;
          if(overlayFailure(error)) {
            if(to-from<=2)throw error;
            job.overlaySplitParts??={};job.overlaySplitParts[splitKey]=[];this.persistExportJob(job);
            this.store.diagnostics?.record('导出分段重试',error.message,{level:'警告'});
            return renderSplit();
          }
          if(copyClean) {
            if(!dual){error.originalCopyFailure=true;throw error;}
            copyClean=false;job.streamCopyFallback=true;job.cleanStreamCopy=false;job.cleanEncodingReason=error.message;
            try{await renderWithAudioFallback();}catch(fallback){if(encoder.hardware&&!overlayFailure(fallback)&&mediaFailure(fallback)!=='action'&&mediaFailure(fallback)!=='temporary')fallback.hardwareEncoderFailure=true;throw fallback;}
          } else {if(encoder.hardware)error.hardwareEncoderFailure=true;throw error;}
        }
      },dual?[out,bakedOut]:[out]);
      if(copyClean)job.cleanStreamCopy=true;
      if(copyAudio)job.audioStreamCopy=true;else delete job.audioStreamCopy;
      parts.push(out);outputOffset+=to-from;
      this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.94,.01+.93*outputOffset/totalDuration),job.id);
    }
    this.store.run("UPDATE jobs SET status='finalizing',progress=.95 WHERE id=?",job.id);
    const results=await checkpoint.run('final-output',async()=>{
    if(!singlePart) {
      await fs.writeFile(path.join(workDir,'concat.txt'),parts.map(p=>`file '${p}'`).join('\n'));
      await this.process(['-f','concat','-safe','1','-i','concat.txt','-c','copy','-movflags','+faststart','-y','final.mp4'],{cwd:workDir});
    }
    const results=[{temporary:'final.mp4',file:output}];
    if(dual){
      if(!singlePart) {
        await fs.writeFile(path.join(workDir,'concat-danmaku.txt'),parts.map(p=>`file '${p.replace('.mp4','-danmaku.mp4')}'`).join('\n'));
        await this.process(['-f','concat','-safe','1','-i','concat-danmaku.txt','-c','copy','-movflags','+faststart','-y','final-danmaku.mp4'],{cwd:workDir});
      }
      results.push({temporary:'final-danmaku.mp4',file:clipFile(output,'danmaku')});
    }
    return results;
    },value=>value.map(item=>item.temporary));
    // A resumed job may reserve a new destination without changing its media.
    for(const result of results)result.file=result.temporary==='final-danmaku.mp4'?clipFile(output,'danmaku'):output;
    if(dual)job.output.danmakuFile=results[1].file;
    return await this.publishFiles(job,workDir,results);
    } finally {
      await checkpoint.finish();
    }
  }
  close(){this.closed=true;this.preparationShutdown?.abort();this.scheduler?.close();this.previewRequests?.close();for(const active of this.previews.values())active.controller.abort();for(const child of this.children)stopChild(child);
    for(const [id,handoff] of this.preparationHandoffs||[]){void handoff.release(id).catch(()=>{});}this.preparationHandoffs?.clear();}
}
