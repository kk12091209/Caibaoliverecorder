import { stopChild } from './child-stop.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { DanmakuFonts } from './danmaku-font.js';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sourceStream, seekBase } from './ingest.js';
import { validateRanges } from './store.js';
import { directories, writableDirectory, exportScopeDirectory } from './directories.js';
import { outputSpan, reserveClip, reserveFull, clipFile } from './output-names.js';
import { detectExportEncoder, encoderArguments, softwareEncoder, videoMetadata, videoGeometryFilter, canCopyFullSource } from './export-encoding.js';
import { TemporaryWorkspaces } from './temp-workspaces.js';
import { ExportPublication } from './export-publication.js';
import { RenderCache } from './render-cache.js';
import { RenderPipeline, visibleComments } from './render-plan.js';
import { danmakuGeometry, assOpacity, savedDanmakuStyle } from '../shared/danmaku-style.js';
import { chatRate } from './chat-rules.js';
import { scrollingTracks, danmakuText } from '../shared/danmaku-tracks.js';

function assTime(t) { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60; return `${h}:${String(m).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`; }
export function assText(messages, width = 1280, height = 720, font = null, style) {
  const geometry=danmakuGeometry(height,style),{size,lineHeight,top,lanes:laneCount}=geometry,alpha=assOpacity(style),shadowAlpha=assOpacity(style,128);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font?.family||'Microsoft YaHei'},${size},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}111111,&H${shadowAlpha}000000,${font?.bold?-1:0},${font?.italic?-1:0},0,0,100,100,0,0,1,1.5,0,7,20,20,20,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const planned=messages.every(m=>Number.isInteger(m.lane)&&m.lane>=0&&m.lane<laneCount&&Number.isFinite(m.textWidth)&&m.textWidth>0)?messages:scrollingTracks(messages,{width,...geometry,font});
  return head + planned.map(m => {
    if(m.time+6<=0)return '';
    const lane=m.lane,content=danmakuText(m.text),xEnd=-m.textWidth,y=top+lane*lineHeight;
    const startX=width+(xEnd-width)*Math.max(0,-m.time)/6;
    return `Dialogue: 0,${assTime(m.time)},${assTime(m.time+6)},Default,,0,0,0,,{\\move(${startX},${y},${xEnd},${y})}${content}\n`;
  }).join('');
}

export class Media {
  exportContext = new AsyncLocalStorage();
  exportOperations = new Map();
  exportSignal(signal) {
    const jobSignal=this.exportContext?.getStore()?.controller.signal;
    return jobSignal?(signal?AbortSignal.any([signal,jobSignal]):jobSignal):signal;
  }
  assertExportActive() {
    if(this.exportContext?.getStore()?.controller.signal.aborted)throw Object.assign(new Error('导出已取消。'),{code:'EXPORT_CANCELLED'});
  }
  async cancelExport(id) {
    const row=this.store.get('SELECT * FROM jobs WHERE id=?',id);
    if(!row)throw new Error('导出任务不存在。');
    if(['cancelled','canceled'].includes(row.status))return {ok:true,status:'cancelled'};
    if(row.status==='queued') {
      this.store.run("UPDATE jobs SET status='cancelled',error='' WHERE id=? AND status='queued'",id);
      await this.releaseReservation(JSON.parse(row.data));
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
    const operation={job,controller:new AbortController(),done:null};
    this.exportOperations.set(job.id,operation);
    operation.done=this.exportContext.run(operation,()=>Promise.resolve().then(()=>{this.assertExportActive();return this.performExportJob(job);}))
      .finally(()=>this.exportOperations.delete(job.id));
    return operation.done;
  }
  constructor(store, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', exportAcceleration = process.env.EXPORT_ACCELERATION || 'auto', renderBlockSeconds = 60, renderCacheOptions } = {}) { this.store = store; this.fonts = new DanmakuFonts(store); this.temporaryRoot = path.join(store.root,'temp'); this.temporaryWorkspaces = new TemporaryWorkspaces(this.temporaryRoot); this.publication = new ExportPublication(this.temporaryWorkspaces); this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; this.previews = new Map(); this.enqueues = new Set(); this.probes = new Set(); this.saves = new Map(); this.savePreparations = new Set(); this.retrying = new Set(); this.blockedSessions = new Map(); this.processing = false; this.children = new Set(); this.backgroundChildren = new Set(); this.exportAcceleration = exportAcceleration; this.exportEncoder = null; this.closed = false; this.renderCache=new RenderCache(store.root,renderCacheOptions);this.renderer=new RenderPipeline(this,assText,{blockSeconds:renderBlockSeconds}); }
  prepareNext(id,options){return this.renderer.prepareNext(id,options);}
  invalidatePreparation(id){this.renderer.invalidate(id);}
  // Preview and audio analysis can run beside preparation. Cleanup still uses
  // the default broad check, so their readers/processes remain protected.
  interactiveChildren = new Set();
  hasForegroundWork({includeInteractive=true}={}){return this.processing||this.enqueues.size>0||(includeInteractive&&this.previews.size>0)||[...this.probes].some(probe=>!probe.background)||this.saves.size>0||this.savePreparations.size>0||[...this.children].some(child=>!this.backgroundChildren.has(child)&&(includeInteractive||!this.interactiveChildren.has(child)));}
  assertSessionAvailable(id) {if(this.closed)throw new Error('视频服务已关闭。');if(this.blockedSessions.has(id)||this.store.deletions?.has(id))throw new Error('素材正在删除，请稍后再试。');if(!this.store.session(id))throw new Error('找不到录像，素材不存在或已删除。');}
  async cancelPreviews(id) {
    this.blockedSessions.set(id,(this.blockedSessions.get(id)||0)+1);
    const active=[...this.previews.values()].filter(item=>item.sessionId===id);
    for(const item of [...active,...this.probes].filter(item=>item.sessionId===id))item.controller?.abort();
    await Promise.allSettled([...active,...[...this.enqueues,...this.probes].filter(item=>item.sessionId===id)].map(item=>item.done));
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
  process(args, { input, output, signal, progress, cwd, background=false, interactive=false } = {}) {
    signal=Media.prototype.exportSignal.call(this,signal);
    const exportSignal=this.exportContext?.getStore()?.controller.signal;
    if(this.closed)return Promise.reject(new Error('视频服务已关闭。'));
    if(signal?.aborted)return Promise.reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));
    const child = this.spawnTracked(this.ffmpeg, ['-hide_banner','-loglevel','warning','-nostdin',...args], { cwd, windowsHide: true, stdio: ['pipe', output ? 'pipe' : 'ignore', 'pipe'] },cwd);
    this.children.add(child);if(background)this.backgroundChildren.add(child);if(interactive)this.interactiveChildren.add(child); let log = '';
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    child.stderr.on('data', b => { log = (log+b).slice(-16000); progress?.(log); });
    const done = new Promise((resolve, reject) => { let spawnError;child.once('error', error=>{spawnError=error;}); child.once('close', code => { this.children.delete(child);this.backgroundChildren.delete(child);this.interactiveChildren.delete(child); if (signal?.aborted) resolve(); else if(spawnError)reject(spawnError);else if(code===0)resolve();else reject(new Error(`视频处理失败 (${code})：${log.slice(-1200)}`)); }); });
    const inputStream = input ? Readable.from(input,{objectMode:false,highWaterMark:256*1024}) : null;
    const abort = () => { inputStream?.destroy(); stopChild(child); }; signal?.addEventListener('abort', abort, { once: true });
    if(signal?.aborted)abort();
    const inputDone = inputStream ? pipeline(inputStream, child.stdin).catch(e => { if (!['EPIPE','ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE'].includes(e.code) && !signal?.aborted) { stopChild(child); throw e; } }) : (child.stdin.end(), Promise.resolve());
    const outputDone = output ? pipeline(child.stdout, output).catch(e => { stopChild(child); if (!signal?.aborted) throw e; }) : Promise.resolve();
    // A failed pipe can reject before FFmpeg closes. Do not hand its workspace
    // back to the scheduler or cleanup until every pipe and the child settles.
    return Promise.allSettled([done,inputDone,outputDone]).then(results=>{
      if(exportSignal?.aborted)throw Object.assign(new Error('导出已取消。'),{code:'EXPORT_CANCELLED'});
      const failed=[results[1],results[2],results[0]].find(result=>result.status==='rejected');if(failed)throw failed.reason;
    }).finally(() => signal?.removeEventListener('abort', abort));
  }
  async probe(file,{signal,background=false}={}) {
    signal=this.exportSignal(signal);
    return new Promise((resolve,reject) => {
      if(signal?.aborted)return reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));
      const child = this.spawnTracked(this.ffprobe, ['-v','error','-analyzeduration','1000000','-probesize','1000000','-show_data_hash','sha256','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_aspect_ratio,profile,level,time_base,extradata_hash,nb_frames,duration','-of','json', file], {windowsHide:true},path.dirname(file));
      let output='',log='',timedOut=false;this.children.add(child);if(background)this.backgroundChildren.add(child);
      const abort=()=>stopChild(child);signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data', b => output+=b);child.stderr.on('data',b=>log=(log+b).slice(-2000));
      const timeout=setTimeout(()=>{timedOut=true;stopChild(child);},15000);
      child.once('error',e=>{clearTimeout(timeout);this.children.delete(child);this.backgroundChildren.delete(child);signal?.removeEventListener('abort',abort);reject(new Error(`无法启动视频信息读取工具：${e.message}`));});
      child.once('close', code => { clearTimeout(timeout);this.children.delete(child);this.backgroundChildren.delete(child);signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Object.assign(new Error('处理已取消。'),{name:'AbortError'}));if(timedOut)return reject(new Error('读取视频信息超时，请检查素材文件是否可正常访问。'));if(code)return reject(new Error(`读取视频信息失败：${log.trim()||'工具退出码 '+code}`));try {resolve(videoMetadata(JSON.parse(output).streams));}catch(e){reject(e);} });
    });
  }
  async probeSource(source,time=source.start,options={}) {
    const controller=new AbortController();
    options={...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal};
    const operation={sessionId:source.session,controller,background:options.background,done:this.probeSourceInternal(source,time,options)};this.probes.add(operation);
    try{return await operation.done;}finally{this.probes.delete(operation);}
  }
  async probeSourceInternal(source,time,options={}) {
    this.assertSessionAvailable(source.session);
    const cached=this.store.setting('metadata:'+source.id);
    if(cached?.metadataVersion>=2&&cached.width>0&&cached.height>0&&Number.isFinite(cached.fps)&&cached.fps>0)return cached;
    const dir=await this.temporaryDirectory('bili-probe-',source.session),file=path.join(dir,'sample.flv');
    try{
      const handle=await fs.open(file,'wx');
      try{for await(const bytes of sourceStream(this.store,source.id,time,Math.min(source.start+source.duration,time+5),{signal:options.signal}))await handle.writeFile(bytes);}
      finally{await handle.close();}
      const info=await this.probe(file,options);
      if(!this.blockedSessions.has(source.session)&&this.store.session(source.session))this.store.setting('metadata:'+source.id,info);
      return info;
    }catch(e){if(e.code==='ENOENT')throw new Error('内部素材片段缺失，无法读取视频信息。请恢复该素材的内部文件后再导出。');throw e;}
    finally{await this.temporaryWorkspaces.finish(dir);}
  }
  async preview(sessionId, start, response, signal) {
    this.assertSessionAvailable(sessionId);
    if(!this.store.session(sessionId))throw new Error('素材不存在或已删除。');
    if (this.previews.size >= 3) throw new Error('同时预览数量已达上限，请关闭其他预览窗口。');
    const source = this.store.sources(sessionId).find(s => s.start <= start + .05 && s.start+s.duration >= start-.05);
    if (!source) throw new Error('所选位置暂未录到画面，或处于直播断流区间。');
    const base = seekBase(this.store,source.id,start); if(base===undefined) throw new Error('正在等待关键帧。');
    const token=randomUUID(),controller=new AbortController(),active={sessionId,controller,done:null};
    signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
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
  async enqueue(id, input) {
    const operation={sessionId:id,done:this.enqueueInternal(id,input)};this.enqueues.add(operation);
    try{return await operation.done;}finally{this.enqueues.delete(operation);}
  }
  async enqueueInternal(id, input) {
    this.assertSessionAvailable(id);
    if(this.preparation)await this.preparation.yieldForForeground();
    this.assertSessionAvailable(id);
    const session=this.store.session(id); if(!session) throw new Error('找不到录像。');
    const scope=input.scope??'clips';if(!['clips','full'].includes(scope))throw new Error('请选择有效的导出范围。');
    const sources=this.store.sources(id);if(scope==='full')this.assertFullReady(session,sources);
    const edit=this.store.edit(id),requested=scope==='full'?[{start:0,end:session.duration}]:input.ranges??edit.ranges;
    if(!Array.isArray(requested)||requested.some(r=>!r||typeof r!=='object'))throw new Error('请选择有效的导出选段。');
    const ranges=validateRanges(requested.filter(r=>r.selected!==false),session.duration);
    if(['includeDanmaku','burn','danmakuFps'].some(key=>key in input))throw new Error('不支持的导出选项，请使用纯净版、弹幕版或双文件模式。');
    const mode=input.mode??'dual';if(!['clean','danmaku','dual'].includes(mode))throw new Error('请选择纯净版、弹幕版或双文件版本。');
    // Reserve the entire selection before publishing any task. A failed batch
    // must not leave an invisible subset exporting in the background.
    const batchId=randomUUID(),jobs=(scope==='full'?[ranges]:ranges.map(range=>[range])).map((part,index)=>({id:randomUUID(),session:id,ranges:part,excluded:[...edit.excluded],filterLottery:edit.filterLottery!==false,revision:edit.revision,font:this.fonts.selected(),danmakuStyle:savedDanmakuStyle(this.store),danmakuPerSecond:chatRate(this.store),mode,scope,batchId,clipIndex:index+1,clipCount:scope==='full'?1:ranges.length}));
    try {
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
  async work() {
    if(this.processing) return; this.processing=true;
    try { let job; while(!this.closed&&(job=this.store.get("SELECT * FROM jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1"))) {
      this.store.run("UPDATE jobs SET status='running',progress=.01 WHERE id=?",job.id);
      let details;
      try { details=JSON.parse(job.data);await this.exportJob(details); }
      catch(e){
        const suspended=this.suspendedJobs?.has(job.id),cancelled=e.code==='EXPORT_CANCELLED'||this.store.get('SELECT status FROM jobs WHERE id=?',job.id)?.status==='cancelling';
        if(details){if(suspended)details.resumeOnLaunch=true;else delete details.resumeOnLaunch;}
        this.store.run("UPDATE jobs SET status=?,error=?,data=? WHERE id=?",suspended?'interrupted':cancelled?'cancelled':e.savePending?'save_failed':'failed',suspended||cancelled?'':e.message,details===undefined?job.data:JSON.stringify(details),job.id);
      }
    }} finally {this.processing=false;}
  }
  async recoverPendingSaves() {
    for(const row of this.store.all("SELECT id,data FROM jobs WHERE status IN ('failed','saving','save_failed','finalizing','running','interrupted')")) {
      const job=JSON.parse(row.data);
      const pending=await this.publication.discover(row.id);
      if(!pending) {
        if(await this.publication.verifyPublished(job))this.completeSave(job);
        continue;
      }
      job.pendingPublication=pending;job.canRetrySave=true;
      this.store.run("UPDATE jobs SET status='save_failed',progress=.98,data=?,error=? WHERE id=?",JSON.stringify(job),'视频已处理完成，请重试保存。',row.id);
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
    for(const row of this.store.all("SELECT * FROM jobs WHERE status IN ('interrupted','save_failed')")){
      const job=JSON.parse(row.data);
      if(job.resumeOnLaunch!==true)continue;
      if(!this.store.session(job.session)){
        delete job.resumeOnLaunch;
        this.store.run("UPDATE jobs SET status='failed',error='素材不存在，无法恢复导出。',data=? WHERE id=?",JSON.stringify(job),row.id);continue;
      }
      if(row.status==='save_failed'){
        try{await this.retrySave(row.id);}catch(error){delete job.resumeOnLaunch;this.store.run("UPDATE jobs SET data=?,error=? WHERE id=?",JSON.stringify(job),error.message,row.id);}continue;
      }
      try{
        const occupied=async file=>{try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
        if(job.scope==='full'||!job.output||await occupied(job.output.file)||job.output.danmakuFile&&await occupied(job.output.danmakuFile)){
          await this.releaseReservation(job);
          job.output=await this.reserveOutput(job,this.store.session(job.session),this.store.sources(job.session));
          Object.assign(job.output,{namingVersion:2,sidecars:false});
          if(job.mode!=='clean')job.output.danmakuFile=clipFile(job.output.file,'danmaku');
        }
        this.store.run("UPDATE jobs SET status='queued',progress=0,error='',data=?,file=? WHERE id=?",JSON.stringify(job),job.mode==='danmaku'?job.output.danmakuFile:job.output.file,row.id);
      }catch(error){delete job.resumeOnLaunch;this.store.run("UPDATE jobs SET status='failed',error=?,data=? WHERE id=?",error.message,JSON.stringify(job),row.id);}
    }
  }
  async retrySave(id,input={}) {
    const operation=this.retrySaveInternal(id,input);this.savePreparations.add(operation);
    try{return await operation;}finally{this.savePreparations.delete(operation);}
  }
  async retrySaveInternal(id,input={}) {
    if(this.closed)throw new Error('视频服务已关闭。');
    if(this.retrying.has(id)||this.saves.has(id))throw new Error('这个任务正在保存，请稍候。');
    const row=this.store.get('SELECT * FROM jobs WHERE id=?',id);
    if(!row||row.status!=='save_failed')throw new Error('这个任务没有可以重试保存的视频。');
    const job=JSON.parse(row.data);this.assertSessionAvailable(job.session);
    if(!this.store.session(job.session))throw new Error('素材不存在或已删除。');
    this.retrying.add(id);
    let newReservation;
    try {
      const pending=await this.publication.discover(id);
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
    try {
      const result=await this.publication.publish(job.id,directory,{outputRoot:job.outputRoot,output:job.output});
      job.publishedFiles=result.publishedFiles;
      if(this.suspendedJobs?.has(job.id))job.resumeOnLaunch=true;
      this.store.run('UPDATE jobs SET data=?,file=? WHERE id=?',JSON.stringify(job),result.file,job.id);
      await this.publication.commit(job.id,directory,result.publishedFiles);
      return this.completeSave(job,result.file);
    }catch(error){error.savePending=true;error.directory=directory;throw error;}
  }
  completeSave(job,file=job.mode==='danmaku'?clipFile(job.output.file,'danmaku'):job.output.file) {
    delete job.pendingPublication;delete job.resumeOnLaunch;job.canRetrySave=false;
    this.store.run("UPDATE jobs SET status='done',progress=1,error='',data=?,file=? WHERE id=?",JSON.stringify(job),file,job.id);
    this.preparation?.wake();
    return file;
  }
  async performExportJob(job) {
    try {
    if(this.closed)throw new Error('视频服务已关闭。');
    this.assertSessionAvailable(job.session);
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
    const copyClean=canCopyFullSource(job,sources,info,seekBase(this.store,first.id,job.ranges[0].start));
    if(job.scope==='full'&&job.mode==='clean'){
      job.cleanStreamCopy=false;
      job.cleanStreamCopyEligible=copyClean;
      if(!copyClean)job.cleanEncodingReason='不满足完整原片安全码流复制条件，使用现有完整导出编码。';
    }
    const cleanOnly=job.mode==='clean';
    let encoder;
    if(copyClean&&cleanOnly)encoder=softwareEncoder();
    else {
      this.exportEncoder??=this.exportAcceleration==='software'?Promise.resolve(softwareEncoder()):detectExportEncoder((args,options)=>this.process(args,options));
      encoder=await this.exportEncoder;
    }
    if(this.closed)throw new Error('视频服务已关闭。');
    const recordEncoder=()=>{job.encoder=encoder.id;job.encoderLabel=encoder.label;this.store.run('UPDATE jobs SET data=? WHERE id=?',JSON.stringify(job),job.id);};
    recordEncoder();
    let file;
    const immediateParallel=encoder.hardware&&job.ranges.reduce((sum,range)=>sum+range.end-range.start,0)>=60;
    if(['danmaku','dual'].includes(job.mode)&&this.store.session(job.session)?.status==='finished'&&sources.every(source=>source.closed===2)&&(immediateParallel||await this.renderCache.hasReady(job.session))) {
      try {
        job.output??=await this.reserveOutput(job,this.store.session(job.session),sources);
        Object.assign(job.output,{namingVersion:2,sidecars:false});
        return await this.renderer.exportJob(job,encoder);
      }catch(error) {
        this.assertExportActive();
        if(error.savePending||this.closed)throw error;
        // Missing, changed or incompatible cache is only an optimization miss.
        // A publication failure must keep its finished video and never re-encode.
        job.preparationFallback=error.message;
        if(encoder.hardware&&error.hardwareEncoderFailure) {
          encoder=softwareEncoder();this.exportEncoder=Promise.resolve(encoder);
          job.encoderFallback=true;recordEncoder();
        }
      }
    }
    try { file=await this.encodeJob(job,encoder,{first,info,copyClean}); }
    catch(e) {
      this.assertExportActive();
      if(this.closed||!encoder.hardware||!e.hardwareEncoderFailure)throw e;
      // Rebuild every part with the same software encoder. Mixing partially
      // completed GPU and CPU parts can make the final concatenation unreliable.
      encoder=softwareEncoder();this.exportEncoder=Promise.resolve(encoder);
      job.encoderFallback=true;recordEncoder();
      file=await this.encodeJob(job,encoder,{first,info,copyClean});
    }
    return file;
    } finally {
      await this.releaseReservation(job);
    }
  }
  async encodeJob(job,encoder,prepared={}) {
    if(!this.store.session(job.session))throw new Error('素材不存在或已删除。');
    const sources=this.store.sources(job.session), excluded=new Set(job.excluded), parts=[];
    const dual=job.mode==='dual',bakedOnly=job.mode==='danmaku';
    job.output??=await this.reserveOutput(job,this.store.session(job.session),sources);
    Object.assign(job.output,{namingVersion:2,sidecars:false});
    if(dual||bakedOnly)job.output.danmakuFile=clipFile(job.output.file,'danmaku');
    else delete job.output.danmakuFile;
    const output=bakedOnly?clipFile(job.output.file,'danmaku'):job.output.file;
    const segments=[];
    for(const range of job.ranges) {
      let cursor=range.start;
      for(const source of sources.filter(s=>s.start<range.end&&s.start+s.duration>range.start)) {
        const from=Math.max(cursor,source.start),to=Math.min(range.end,source.start+source.duration);
        if(to<=from)continue;
        if(from-cursor>.15&&job.scope!=='full')throw new Error('选段跨越直播断流空缺，请分别添加空缺前后的选段，避免伪造缺失画面。');
        segments.push({source,from,to});cursor=to;
      }
      if(range.end-cursor>.15)throw new Error('选段末尾尚未完整写入，请稍后重新导出。');
    }
    const first=segments[0]?.source;if(!first)throw new Error('选段中没有已录制的画面。');
    const info=prepared.first?.id===first.id?prepared.info:await this.probeSource(first,segments[0].from);
    const width=Math.max(2,Math.floor(info.width/2)*2),height=Math.max(2,Math.floor(info.height/2)*2);
    const layoutFont=job.font?.id?await this.fonts.selection(job.font.id):job.font;
    const chatLayout=dual||bakedOnly?await this.renderer.layout(job.session,undefined,job.danmakuPerSecond??chatRate(this.store),{width,height,style:job.danmakuStyle,font:layoutFont}):null;
    const workDir=await this.temporaryDirectory('bili-export-',job.session);
    try {
    const fontDirectory=await this.fonts.stage(job.font,workDir);
    let outputOffset=0;
    const totalDuration=segments.reduce((sum,segment)=>sum+segment.to-segment.from,0),singlePart=segments.length===1;
    for(const {source,from,to} of segments) {
        const base=seekBase(this.store,source.id,from); if(base===undefined) throw new Error('选段没有可用关键帧。');
        const number=parts.length,subFile=`part-${number}.ass`,out=`part-${number}.mp4`;
        if(dual||bakedOnly) {
          const messages=visibleComments(chatLayout,{excluded,filterLottery:job.filterLottery!==false},from,to);
          // ASS runs before the output seek, so its clock starts at the preceding keyframe.
          await fs.writeFile(path.join(workDir,subFile),assText(messages.map(m=>({...m,time:m.time-base})),width,height,job.font,job.danmakuStyle));
        }
        const sourceInfo=source.id===first.id?info:await this.probeSource(source,from);
        const filter=videoGeometryFilter(sourceInfo,width,height);
        const overlayFilter=`fps=60,ass=${subFile}${fontDirectory?':fontsdir='+fontDirectory:''}`;
        const compatibleFull=singlePart&&canCopyFullSource(job,sources,sourceInfo,base);
        let copyClean=!bakedOnly&&compatibleFull;
        let copyAudio=compatibleFull&&sourceInfo.audioStreams===1&&sourceInfo.audioCodec==='aac'&&!job.audioStreamCopyFallback;
        const mux=singlePart?['-movflags','+faststart']:[];
        const encode=(map,file,baked=false)=>['-ss',String(Math.max(0,from-base)),'-t',String(to-from),'-map',map,'-map','0:a:0?',
          ...encoderArguments(encoder,dual&&!copyClean),'-pix_fmt','yuv420p','-r',String(baked?60:info.fps),
          ...(copyAudio?['-c:a','copy']:['-c:a','aac','-b:a','192k']),...mux,'-y',file];
        const copied=file=>['-t',String(to-from),'-map','0:v:0','-map','0:a:0?',
          ...(job.audioStreamCopyFallback?['-c:v','copy','-c:a','aac','-b:a','192k']:['-c','copy']),...mux,'-y',file];
        const command=()=>{
          let filters=[],outputs;
          if(dual) {
            const graph=copyClean?`[0:v:0]${overlayFilter}[danmaku]`:`[0:v:0]${filter?filter+',':''}split=2[clean][overlay];[overlay]${overlayFilter}[danmaku]`;
            filters=['-filter_complex_threads','2','-filter_complex',graph];
            outputs=[...(copyClean?copied(out):encode('[clean]',out)),...encode('[danmaku]',`part-${number}-danmaku.mp4`,true)];
          } else if(copyClean)outputs=copied(out);
          else {
            const chain=[filter,...(bakedOnly?[overlayFilter]:[])].filter(Boolean).join(',');
            if(chain)filters=['-filter_threads','2','-vf',chain];
            outputs=encode('0:v:0',out,bakedOnly);
          }
          return ['-stats_period','1','-progress','pipe:2','-nostats','-fflags','+genpts','-threads','2','-f','flv','-i','pipe:0',...filters,...outputs];
        };
        let lastProgress=0;
        const render=()=>this.process(command(),
            {cwd:workDir,input:sourceStream(this.store,source.id,from,to),progress:log=>{
              if(this.closed)return;
              const matches=[...log.matchAll(/(?:^|\n)out_time_us=(\d+)/g)],seconds=Number(matches.at(-1)?.[1])/1000000;
              if(!Number.isFinite(seconds)||Date.now()-lastProgress<750)return;lastProgress=Date.now();
              this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.94,.01+.93*(outputOffset+Math.max(0,Math.min(to-from,seconds)))/totalDuration),job.id);
            }});
        const renderWithAudioFallback=async()=>{
          try{await render();}catch(error){
            // Only an explicit AAC packet/header rejection invalidates audio
            // copying. GPU failures keep the same audio path on the CPU retry.
            if(this.closed||!copyAudio||!/(?:malformed AAC bitstream|AAC bitstream[^\r\n]*(?:ADTS|extradata)|could not find tag for codec aac)/i.test(error.message))throw error;
            copyAudio=false;job.audioStreamCopyFallback=true;await render();
          }
        };
        try {await renderWithAudioFallback();}
        catch(error) {
          this.assertExportActive();
          if(this.closed)throw error;
          if(copyClean) {
            // A compatible probe is conservative, but a muxer can still reject
            // a damaged stream. Retry the same complete part with normal encode.
            copyClean=false;job.streamCopyFallback=true;job.cleanStreamCopy=false;job.cleanEncodingReason=error.message;
            try{await renderWithAudioFallback();}catch(fallback){if(encoder.hardware)fallback.hardwareEncoderFailure=true;throw fallback;}
          } else {if(encoder.hardware)error.hardwareEncoderFailure=true;throw error;}
        }
        if(copyClean)job.cleanStreamCopy=true;
        if(copyAudio)job.audioStreamCopy=true;else delete job.audioStreamCopy;
        parts.push(out); outputOffset+=to-from;
      this.store.run('UPDATE jobs SET progress=MAX(progress,?) WHERE id=?',Math.min(.94,.01+.93*outputOffset/totalDuration),job.id);
    }
    this.store.run("UPDATE jobs SET status='finalizing',progress=.95 WHERE id=?",job.id);
    if(singlePart)await fs.rename(path.join(workDir,parts[0]),path.join(workDir,'final.mp4'));
    else {
      await fs.writeFile(path.join(workDir,'concat.txt'),parts.map(p=>`file '${p}'`).join('\n'));
      await this.process(['-f','concat','-safe','1','-i','concat.txt','-c','copy','-movflags','+faststart','-y','final.mp4'],{cwd:workDir});
    }
    const results=[{temporary:'final.mp4',file:output}];
    if(dual){
      if(singlePart)await fs.rename(path.join(workDir,parts[0].replace('.mp4','-danmaku.mp4')),path.join(workDir,'final-danmaku.mp4'));
      else {
        await fs.writeFile(path.join(workDir,'concat-danmaku.txt'),parts.map(p=>`file '${p.replace('.mp4','-danmaku.mp4')}'`).join('\n'));
        await this.process(['-f','concat','-safe','1','-i','concat-danmaku.txt','-c','copy','-movflags','+faststart','-y','final-danmaku.mp4'],{cwd:workDir});
      }
      results.push({temporary:'final-danmaku.mp4',file:clipFile(output,'danmaku')});
    }
    if(dual)job.output.danmakuFile=results[1].file;
    this.assertExportActive();
    this.store.run("UPDATE jobs SET status='saving',progress=.98 WHERE id=?",job.id);
    job.pendingPublication=await this.publication.stage(job,workDir,results);job.canRetrySave=true;
    try {
      this.store.run("UPDATE jobs SET status='saving',progress=.98,data=? WHERE id=?",JSON.stringify(job),job.id);
      return await this.publishEncoded(job,workDir);
    }catch(error){error.savePending=true;error.directory=workDir;throw error;}
    } finally {
      await this.temporaryWorkspaces.finish(workDir);
    }
  }
  close(){this.closed=true;for(const active of this.previews.values())active.controller.abort();for(const child of this.children)stopChild(child);}
}
