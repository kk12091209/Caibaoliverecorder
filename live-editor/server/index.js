import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { chatRate, validateChatRate, CHAT_RATE_SETTING } from './chat-rules.js';
import { Ingestor } from './ingest.js';
import { CompactStorage } from './compact-storage.js';
import { Media } from './media.js';
import { MAX_FONT_BYTES } from './danmaku-font.js';
import { BackgroundPreparation } from './background-preparation.js';
import { JobDeletion } from './job-deletion.js';
import { DeletionMaintenance } from './deletion-maintenance.js';
import { SessionDeletion } from './session-deletion.js';
import { WaveformService } from './waveform.js';
import { DensityService } from './density.js';
import { MultiPlatformRecorder } from './multi-platform-recorder.js';
import { directories, writableDirectory, openDirectory } from './directories.js';
import { exportedJobFile } from './output-names.js';
import { resolveRuntimeTool, resolveProjectRoot } from './runtime-paths.js';
import { ServiceRuntime } from './service-runtime.js';
import { DesktopExit } from './desktop-exit.js';
import { Updates } from './updates.js';
import { AutoUpdate } from './auto-update.js';
import { DailyDiagnostics } from './diagnostics.js';
import { listenLocal } from './local-endpoint.js';

const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function createApp(options={}) {
  const root=path.resolve(options.data??process.env.EDITOR_DATA??path.join(appRoot,'data'));
  const runtime=await ServiceRuntime.acquire(root,appRoot,{managed:options.desktopManaged??process.env.EDITOR_DESKTOP_MANAGED==='1',...options.runtimeOptions});
  try{
    const packageInfo=JSON.parse(await fs.readFile(path.join(appRoot,'package.json'),'utf8'));
    runtime.diagnostics=await DailyDiagnostics.open(root,{version:packageInfo.version,...options.diagnosticOptions});
    runtime.diagnostics.protectSecret(runtime.token);
    return await createManagedApp(options,runtime);
  }catch(error){runtime.diagnostics?.record('启动',error,{level:'错误'});await runtime.diagnostics?.close('启动失败，后台退出');await runtime.release();throw error;}
}
async function createManagedApp(options,runtime) {
  let port=Number(options.port??process.env.EDITOR_PORT??0);
  const root=runtime.root,diagnostics=runtime.diagnostics;
  const projectRoot=resolveProjectRoot(appRoot,options.projectRoot??process.env.EDITOR_PROJECT_ROOT);
  const ffmpeg=resolveRuntimeTool(projectRoot,'ffmpeg',{override:options.ffmpeg});
  const ffprobe=resolveRuntimeTool(projectRoot,'ffprobe',{override:options.ffprobe});
  const executable=options.noRecorder?'':resolveRuntimeTool(projectRoot,'recorder',{override:options.recorder,required:false});
  const store=new Store(root);store.diagnostics=diagnostics;
  if(options.defaultExportRoot||process.env.EDITOR_EXPORT_ROOT)store.defaultExportRoot=path.resolve(options.defaultExportRoot||process.env.EDITOR_EXPORT_ROOT);
  store.projectRoot=path.resolve(options.projectRoot??(options.data?path.dirname(root):projectRoot));
  const ingestor=new Ingestor(store),media=new Media(store,{ffmpeg,ffprobe}),storage=new CompactStorage(store),jobDeletion=new JobDeletion(store);
  const waveform=new WaveformService(store,media),density=new DensityService(store);
  store.density=density;
  const recorder=new MultiPlatformRecorder(store,{executable,port:Number(options.recorderPort??process.env.RECORDER_PORT??0),editorPort:port,douyin:options.douyin,bilibiliResolver:options.bilibiliResolver});
  await media.recoverPendingSaves();
  const clients=new Set(); let closing=false,app,closePromise;
  const deletingSessions=new SessionDeletion({store,storage,waveform,media,density,idleMs:options.deletionIdleMs??30000,retryMs:options.deletionRetryMs??1000});
  let autoUpdate;
  const preparation=new BackgroundPreparation(store,media,{
    ...options.preparationOptions,
    busyReason:()=>{
      if(closing||autoUpdate?.applying)return 'foreground';
      if(!options.noRecorder&&recorder.connectionPending)return 'connection';
      if(recorder.rooms.some(room=>room.recording)||store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('recording','waiting') LIMIT 1"))return 'recording';
      if(media.hasForegroundWork?.({includeInteractive:false}))return 'export';
      if(storage.busy)return 'compaction';
      if(store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('importing','finishing') LIMIT 1"))return 'indexing';
      return '';
    }
  });
  media.preparation=preparation;store.preparation=preparation;store.renderCache=media.renderCache;
  store.temporaryWorkspaces=media.temporaryWorkspaces;
  const closeAction=()=>{const saved=store.setting('window-close-action');return ['exit','background'].includes(saved)?saved:'ask';};
  function validateCloseAction(value){if(!['ask','exit','background'].includes(value))throw new Error('请选择有效的关闭窗口方式。');}
  function activity(){
    const recording=recorder.rooms.some(room=>room.recording)||!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('recording','waiting') LIMIT 1");
    const processing=media.hasForegroundWork({includeInteractive:false})||!!store.get("SELECT id FROM jobs WHERE status IN ('queued','running','finalizing','saving','cancelling') LIMIT 1");
    const preparing=!!preparation.active||!!store.get("SELECT session FROM preparation_jobs WHERE paused=0 AND status IN ('queued','preparing') LIMIT 1");
    const organising=ingestor.busy||storage.busy||deletingSessions.size>0||!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('importing','finishing') LIMIT 1");
    const monitoring=recorder.rooms.some(room=>room.recordingEnabled!==false&&(room.autoRecord||room.recordingEnabled===true));
    const busy=recording||processing||preparing||organising||!!recorder.starting||recorder.pollBusy||!!recorder.douyin.polling;
    const exporting=media.processing||media.enqueues.size>0||media.saves.size>0||media.savePreparations.size>0||!!store.get("SELECT id FROM jobs WHERE status IN ('queued','running','finalizing','saving','cancelling') LIMIT 1");
    return {updateBusy:recording||processing||organising||!!preparation.active||media.fonts.changing||!!recorder.starting, busy,background:busy||monitoring,requiresExitConfirmation:recording||exporting,reason:recording?'录制':processing?'导出':preparing?'预处理':organising?'素材整理':monitoring?'监控':'',recorderPort:recorder.port};
  }
  const packageInfo=JSON.parse(await fs.readFile(path.join(appRoot,'package.json'),'utf8'));
  const updates=new Updates(store,{current:{version:packageInfo.version,revision:packageInfo.buildRevision||1},activity,...options.updateOptions});
  await updates.recover();
  const desktopExit=new DesktopExit({runtime,activity,recorder,media,preparation,close:()=>app.close()});
  const deleteMaterial=(id,options)=>deletingSessions.delete(id,options);
  const deletionMaintenance=new DeletionMaintenance(store,{remove:deleteMaterial,busy:()=>closing||deletingSessions.size>0||ingestor.busy||storage.busy||waveform.active||!!preparation.active||media.previews.size>0||media.hasForegroundWork()||recorder.rooms.some(room=>room.recording)||!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status<>'finished' LIMIT 1")});
  autoUpdate=new AutoUpdate({updates,runtime,appRoot,projectRoot,activity,quit:()=>desktopExit.request(false)});
  function snapshot(){return {diagnostics:{error:diagnostics.lastError},danmakuFont:media.fonts.snapshot(),updates:updates.snapshot(),sessions:store.sessions(),rooms:recorder.rooms,recorder:{online:recorder.available,biliOnline:recorder.online,douyinOnline:recorder.douyin.started&&!recorder.douyin.closed,error:recorder.error},preparation:preparation.snapshot(),jobs:store.all("SELECT jobs.id,session,jobs.created,jobs.status,progress,file,jobs.error,mode,data FROM jobs LEFT JOIN sessions ON sessions.id=jobs.session WHERE jobs.session IS NULL OR sessions.deleted_at='' ORDER BY jobs.created DESC,jobs.rowid ASC LIMIT 100").map(job=>{const {data,...entry}=job,details=JSON.parse(data||'{}');return {...entry,scope:details.scope||'clips',clipIndex:details.clipIndex,clipCount:details.clipCount,danmaku_file:exportedJobFile(job,'danmaku')||'',canRetrySave:details.canRetrySave===true,exportDirectory:details.outputRoot||''};}),deletions:deletingSessions.snapshot(),pendingCleanup:store.pendingCleanup(),dataPath:root,paths:directories(store),closeAction:closeAction(),danmakuPerSecond:chatRate(store)};}
  function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  async function body(req){
    if(!req.headers['content-type']?.startsWith('application/json')){const e=new Error('请求必须为 JSON。');e.status=415;throw e;}
    const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>8*1024*1024)throw new Error('请求数据过大。');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  }
  async function sendFile(req,res,file){
    const stat=await fs.stat(file);let start=0,end=stat.size-1,status=200;
    const range=req.headers.range;
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}start=Number(match[1]);end=match[2]?Math.min(end,Number(match[2])):end;status=206;}
    if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.mkv':'video/x-matroska','.flv':'video/x-flv','.xml':'application/xml; charset=utf-8','.json':'application/json','.ass':'text/plain; charset=utf-8','.ttf':'font/ttf','.otf':'font/otf'};
    const headers={'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
    if(['.html','.js','.css'].includes(path.extname(file)))headers['Cache-Control']='no-store';
    if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status,headers);if(req.method==='HEAD')return res.end();
    const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  const server=http.createServer(async(req,res)=>{
    try {
      let match;
      const host=req.headers.host||'';
      if(!new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(host)){json(res,{error:'无效的本机访问地址。'},403);return;}
      const url=new URL(req.url,`http://${host}`),p=url.pathname;
      // Record only the operation name, never query strings or request bodies.
      if(req.method==='POST'&&p.startsWith('/api/'))res.once('finish',()=>{const parts=p.split('/');diagnostics.record('操作结果',`${parts[2]} / ${parts.length>4?parts.at(-1):''}；HTTP ${res.statusCode}`,{level:res.statusCode>=400?'警告':'信息'});});
      if(req.headers.origin && req.headers.origin!==`http://${host}`){json(res,{error:'不允许跨站请求。'},403);return;}
      if(p==='/internal/desktop'){
        if(!runtime.authorized(req))return json(res,{error:'无效的桌面连接。'},403);
        if(req.method==='POST'){
          const input=await body(req);
          if(input.action==='cancelUpdate'){await autoUpdate.cancel();return json(res,runtime.status(activity()));}
          else if(input.action==='applyUpdate')return json(res,{...runtime.status(activity()),...await autoUpdate.apply(input)});
          else if(input.action==='prepareUpdate'){const updatePath=await updates.installPath();return json(res,{...runtime.status(activity()),updatePath});}
          else if(input.action==='heartbeat'){runtime.heartbeat(input.client,input.pid);diagnostics.desktop(input.client,input.pid,input.clientKind??'desktop');}
          else if(input.action==='diagnostic'){if(typeof input.message!=='string'||input.message.length>3000)throw new Error('运行记录无效。');diagnostics.record('桌面',input.message,{level:input.warning===true?'警告':'信息'});}
          else if(input.action==='detach'){runtime.clients.delete(input.client);diagnostics.record('桌面','关闭桌面连接',{important:true});}
          else if(input.action==='setCloseAction'){validateCloseAction(input.closeAction);store.setting('window-close-action',input.closeAction);}
          else if(input.action==='quit'){diagnostics.record('用户操作',`请求退出；已确认停止任务：${input.confirmed===true?'是':'否'}`,{important:true});const decision=await desktopExit.request(input.confirmed??false);return json(res,{...runtime.status(activity()),...decision,closeAction:closeAction()});}
          else if(['exit','restart'].includes(input.action))runtime.request(input.action);
          else throw new Error('无效的桌面操作。');
        }else if(req.method!=='GET')return json(res,{error:'请求方式无效。'},405);
        return json(res,{...runtime.status(activity()),closeAction:closeAction()});
      }
      if((runtime.stopping||autoUpdate.applying)&&req.method==='POST'&&p!=='/internal/recorder-event')return json(res,{error:'后台正在安全切换，请稍后再试。'},503);
      if(p==='/api/updates/apply'&&req.method==='POST'){await body(req);return json(res,updates.requestInstall());}
      if(p==='/api/updates/check'&&req.method==='POST'){await body(req);return json(res,await updates.check());}
      if(p==='/api/updates/download'&&req.method==='POST'){const input=await body(req);return json(res,updates.download(input.key,input.autoInstall===true),202);}
      if(p==='/api/updates/clear'&&req.method==='POST'){await body(req);return json(res,await updates.clearCache());}
      if(p==='/api/updates/cancel'&&req.method==='POST'){await body(req);return json(res,updates.cancel());}
      if(p==='/api/updates/defer'&&req.method==='POST'){await body(req);return json(res,updates.defer());}
      if(p==='/api/updates/settings'&&req.method==='POST'){const input=await body(req);return json(res,updates.setEnabled(input.enabled));}
      if((match=/^\/api\/danmaku-font\/([a-f0-9]{64})$/.exec(p))&&req.method==='GET')return await sendFile(req,res,await media.fonts.file({id:match[1]}));
      if(p==='/api/danmaku-font'&&req.method==='POST'){
        if(media.fonts.changing)throw new Error('正在保存字体，请稍后重试。');
        media.fonts.changing=true;
        try{
          if(req.headers['content-type']==='application/octet-stream'){
            const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>MAX_FONT_BYTES)throw new Error('字体超过 32 MB。');chunks.push(chunk);}await media.fonts.import(Buffer.concat(chunks));
          }else{const input=await body(req);if(input.reset!==true)throw new Error('字体设置无效。');media.fonts.reset();}
          for(const {session} of store.all('SELECT session FROM preparation_jobs'))await preparation.invalidate(session);
          return json(res,{font:media.fonts.snapshot()});
        }finally{media.fonts.changing=false;}
      }
      if(p==='/api/state'&&req.method==='GET')return json(res,snapshot());
      if(p==='/api/events'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(snapshot())}\n\n`);clients.add(res);res.on('close',()=>clients.delete(res));return;
      }
      if(p==='/internal/recorder-event'&&req.method==='POST'){
        if(url.searchParams.get('token')!==recorder.webhookSecret)return json(res,{error:'无效事件来源。'},403);
        await recorder.event(await body(req));return json(res,{ok:true});
      }
      if(p==='/api/rooms'&&req.method==='POST'){
        const input=await body(req),result=await recorder.addRoom(input);diagnostics.record('用户操作',`添加监控；平台 ${result?.platform||'bilibili'}；房间 ${result?.roomId||result?.webRid||'见房间状态'}；自动录制=${input.autoRecord!==false}`);return json(res,result);
      }

      if(p==='/api/preparation/settings'&&req.method==='POST'){
        const input=await body(req);if(typeof input.enabled!=='boolean')throw new Error('请选择是否开启录制完成后的自动预处理。');
        await preparation.setEnabled(input.enabled);return json(res,preparation.snapshot());
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/preparation$/.exec(p))&&req.method==='POST'){
        const input=await body(req),id=match[1];if(!store.session(id))throw new Error('素材不存在或已删除。');
        if(deletingSessions.has(id)||store.deletions?.has(id))throw new Error('素材正在删除，请稍后再试。');
        if(!['start','pause','resume'].includes(input.action))throw new Error('请选择有效的预处理操作。');
        if(input.action==='pause')await preparation.pause(id);
        else {
          const session=store.session(id),sources=store.sources(id);
          if(session.status!=='finished'||!sources.length||sources.some(source=>source.closed!==2))throw new Error('请等待录制结束和素材整理完成后再开始预处理。');
          if(input.action==='start')await preparation.enqueue(id);else await preparation.resume(id);
        }
        return json(res,preparation.snapshot());
      }
      if((match=/^\/api\/rooms\/(\d+|douyin:\d{1,20})\/(start|stop|auto|remove)$/.exec(p))&&req.method==='POST'){
        const input=await body(req);diagnostics.record('用户操作',`直播间 ${match[1]}：${{start:'手动开始录制',stop:'停止录制',auto:'设置自动录制',remove:'移除监控'}[match[2]]}${match[2]==='auto'?`；启用=${input.enabled===true}`:''}`);await recorder.action(match[1],match[2],input);return json(res,{ok:true});
      }
      if(p==='/api/settings'&&req.method==='POST'){
        const input=await body(req);
        if(Object.keys(input).some(key=>!['exportDirectory','closeAction','danmakuPerSecond'].includes(key)))throw new Error('不支持的设置项。');
        if('closeAction' in input)validateCloseAction(input.closeAction);
        if('danmakuPerSecond' in input)validateChatRate(input.danmakuPerSecond);
        if('exportDirectory' in input)store.setting('export-directory',await writableDirectory(input.exportDirectory));
        if('closeAction' in input)store.setting('window-close-action',input.closeAction);
        if('danmakuPerSecond' in input){store.setting(CHAT_RATE_SETTING,input.danmakuPerSecond);recorder.douyin.chat.setRateLimit(input.danmakuPerSecond);}
        return json(res,{ok:true,paths:directories(store),closeAction:closeAction(),danmakuPerSecond:chatRate(store)});
      }
      if(p==='/api/folders/open'&&req.method==='POST')return json(res,{path:await openDirectory(store,await body(req))});
      if((match=/^\/api\/sessions\/([\w-]+)$/.exec(p))&&req.method==='GET'){
        const session=store.session(match[1]);if(!session)return json(res,{error:'录像不存在。'},404);
        const sources=store.sources(session.id).map(s=>({id:s.id,start:s.start,wall:s.wall,duration:s.duration,closed:s.closed,error:s.error,path:s.path,metadata:store.setting('metadata:'+s.id)}));
        for(const source of sources)if(!source.metadata&&source.duration>0){void media.probeSource(store.get('SELECT * FROM sources WHERE id=?',source.id)).catch(()=>{});}
        return json(res,{...session,sources,edit:store.edit(session.id),chunks:store.get('SELECT COUNT(*) AS count FROM chunks WHERE source IN (SELECT id FROM sources WHERE session=?)',session.id).count});
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/edit$/.exec(p))&&req.method==='POST'){
        const id=match[1],previous=store.edit(id),saved=store.saveEdit(id,await body(req));
        const visibility=edit=>JSON.stringify([edit.filterLottery!==false,[...edit.excluded].sort()]);
        if(visibility(previous)!==visibility(saved))await preparation.invalidate(id);
        return json(res,saved);
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/delete$/.exec(p))&&req.method==='POST'){
        const input=await body(req),id=match[1];
        if(input.confirmed!==true)throw new Error('请先确认是否永久删除这份素材。');
        if(input.background===true)return json(res,deletingSessions.start(id).accepted,202);
        if(deletingSessions.has(id))throw new Error('这份素材正在删除，请等待完成。');
        const session=store.get('SELECT * FROM sessions WHERE id=?',id);
        if(!session||session.purged_at)throw new Error('素材不存在或已经彻底删除。');
        if(session.status!=='finished'||store.get('SELECT id FROM sources WHERE session=? AND closed<2',id))throw new Error('这份素材仍在录制或整理中，请结束后再删除。');
        if(session.archive_status==='running'||store.get("SELECT id FROM jobs WHERE session=? AND status IN ('queued','running','finalizing','saving','cancelling')",id))throw new Error('这份素材正在导出或保存，请完成后再删除。');
        if(store.get("SELECT id FROM jobs WHERE session=? AND status='save_failed'",id))throw new Error('这份素材还有编码完成但尚未保存的导出，请先重试保存。');
        const controller=new AbortController(),disconnected=()=>{if(!res.writableFinished)controller.abort();};
        res.once('close',disconnected);
        try{return json(res,await deleteMaterial(id,{signal:controller.signal}));}
        finally{res.removeListener('close',disconnected);}
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/messages$/.exec(p))&&req.method==='GET'){
        if(!store.session(match[1]))return json(res,{error:'素材不存在或已删除。'},404);
        const from=Math.max(0,Number(url.searchParams.get('from')||0)),to=Number(url.searchParams.get('to')||Number.MAX_SAFE_INTEGER),search=(url.searchParams.get('q')||'').slice(0,200);
        if(!Number.isFinite(from)||!Number.isFinite(to))throw new Error('时间范围无效。');
        await store.chatRules.prepare(match[1]);
        return json(res,store.messages(match[1],from,to,search,url.searchParams.get('overlay')==='1'?3000:500));
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/signals$/.exec(p))&&req.method==='GET'){
        const id=match[1],session=store.session(id);
        if(!session)return json(res,{error:'素材不存在或已删除。'},404);
        if(deletingSessions.has(id))throw new Error('素材正在删除，请稍后再试。');
        const from=Number(url.searchParams.get('from')??0),to=Number(url.searchParams.get('to')??session.duration),bins=Number(url.searchParams.get('bins')??600);
        if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>session.duration+.05||!Number.isInteger(bins)||bins<1||bins>1000)throw new Error('波形时间范围无效。');
        const window={from,to:Math.min(to,session.duration),bins};
        return json(res,{from:window.from,to:window.to,audio:waveform.request(id,window),density:density.request(id,window)});
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/preview$/.exec(p))&&req.method==='GET'){
        const start=Number(url.searchParams.get('start')||0);if(!Number.isFinite(start)||start<0)throw new Error('播放位置无效。');
        const abort=new AbortController();res.on('close',()=>abort.abort());await media.preview(match[1],start,res,abort.signal);return;
      }
      if((match=/^\/api\/sessions\/([\w-]+)\/export$/.exec(p))&&req.method==='POST')return json(res,await media.enqueue(match[1],await body(req)));
      if((match=/^\/api\/jobs\/([\w-]+)\/retry-save$/.exec(p))&&req.method==='POST')return json(res,await media.retrySave(match[1],await body(req)));
      if((match=/^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p))&&req.method==='POST'){await body(req);return json(res,await media.cancelExport(match[1]));}
      if((match=/^\/api\/jobs\/([\w-]+)\/delete-preview$/.exec(p))&&req.method==='GET')return json(res,await jobDeletion.preview(match[1]));
      if((match=/^\/api\/jobs\/([\w-]+)\/delete$/.exec(p))&&req.method==='POST')return json(res,await jobDeletion.delete(match[1],await body(req)));
      if(p.startsWith('/api/')||p.startsWith('/internal/'))return json(res,{error:'接口不存在。'},404);
      if(!['GET','HEAD'].includes(req.method))return json(res,{error:'请求方式无效。'},405);
      const dist=path.join(appRoot,'dist');let target=path.resolve(dist,'.'+decodeURIComponent(p));
      if(!target.startsWith(dist+path.sep)&&target!==dist)return json(res,{error:'无效路径。'},403);
      if(p==='/'||!path.extname(target))target=path.join(dist,'index.html');
      return await sendFile(req,res,target);
    }catch(e){diagnostics.record('请求处理',e,{level:'错误'});if(!res.headersSent)json(res,{error:e.code==='ENOENT'?'文件不存在，请检查路径或先构建界面。':e.message},e.status||400);else res.destroy();}
  });
  try{port=await listenLocal(server,port);}
  catch(error){media.close();await recorder.close();store.close();throw error;}
  port=server.address().port;recorder.editorPort=port;
  try{await media.recoverInterruptedExports();await runtime.publish(port);}
  catch(error){media.close();await recorder.close();await media.waitForSaves();await new Promise(resolve=>server.close(resolve));store.close();throw error;}
  ingestor.start();void media.work();if(options.preparation!==false)preparation.start();
  let nextTemporarySweep=0;
  const maintain=()=>{
    if(closing||autoUpdate.applying)return;
    void deletionMaintenance.tick().catch(error=>{deletionMaintenance.lastError=error.message;diagnostics.record('自动清理',error,{level:'警告'});});
    if(options.compact!==false)void storage.tick().catch(error=>{storage.lastError=error.message;diagnostics.record('素材整理',error,{level:'警告'});});
    if(Date.now()>=nextTemporarySweep){nextTemporarySweep=Date.now()+60000;void media.cleanupStaleTemporary().catch(error=>{media.temporaryCleanupError=error.message;diagnostics.record('缓存清理',error,{level:'警告'});});}
  };
  const maintenanceTimer=setInterval(maintain,5000);
  const runtimeTimer=setInterval(()=>{
    if(closing||!runtime.shouldStop(activity()))return;
    runtime.stopping=true;
    void(async()=>{
      if(runtime.pending!=='restart'&&!options.noRecorder&&!await recorder.stopIdle()){runtime.stopping=false;return;}
      await app.close();
    })().catch(error=>{runtime.stopping=false;runtime.lastError=error.message;diagnostics.record('退出',error,{level:'错误'});});
  },options.runtimePollMs??1000);
  maintain();
  if(options.updatesAutoCheck??runtime.managed)updates.start();
  const timer=setInterval(()=>{
    try{
    if(closing)return;
    for(const s of store.all("SELECT * FROM sessions WHERE status IN ('importing','finishing')")){
      const sources=store.sources(s.id);if(sources.length&&sources.every(x=>x.closed===2))store.run("UPDATE sessions SET status='finished' WHERE id=?",s.id);
    }
    for(const client of clients)if(!client.writableNeedDrain)client.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    }catch(error){diagnostics.record('界面状态推送',error,{level:'错误'});}
  },1000);
  const diagnosticPoll=()=>{
    if(closing)return;
    try{
      diagnostics.rooms(recorder.rooms,{biliOnline:recorder.online});
      diagnostics.observe('core',`B站核心：${recorder.online?'已连接':recorder.error||'正在连接'}`,recorder.online?'信息':'警告');
      diagnostics.observe('activity',`后台工作：${activity().reason||'空闲'}`);
      for(const source of store.all('SELECT id,error,closed FROM sources ORDER BY rowid DESC LIMIT 16'))if(source.error)diagnostics.observe('source:'+source.id,`素材 ${source.id} 错误：${source.error}`,'错误');
      for(const job of store.all('SELECT id,status,error FROM jobs ORDER BY rowid DESC LIMIT 32'))diagnostics.observe('job:'+job.id,`导出 ${job.id}：${job.status}${job.error?'；'+job.error:''}`,job.error?'错误':'信息');
      if(runtime.quitError)diagnostics.observe('quit-error',`退出未完成：${runtime.quitError}`,'错误');
      void diagnostics.tick();
    }catch(error){diagnostics.record('运行检查',error,{level:'错误'});}
  };
  const diagnosticTimer=setInterval(diagnosticPoll,30000);diagnosticPoll();
  if(!options.noRecorder)void recorder.start().catch(e=>{recorder.error=e.message;});
  app={diagnostics,updates,store,ingestor,media,storage,waveform,density,preparation,deletionMaintenance,deletingSessions,recorder,runtime,desktopExit,activity,server,port,root,snapshot,close(){return closePromise??=(async()=>{
    closing=true;await updates.close();clearInterval(timer);clearInterval(maintenanceTimer);clearInterval(runtimeTimer);clearInterval(diagnosticTimer);ingestor.stop();media.close();const recorderClosed=recorder.close();
    const deletionsClosed=Promise.allSettled([deletionMaintenance.close(),deletingSessions.close()]);
    const preparationClosed=preparation.close();
    const waveformClosed=waveform.close();density.close();
    for(const client of clients)client.end();
    const httpClosed=new Promise(resolve=>server.close(resolve));
    await storage.close();
    await waveformClosed;
    await preparationClosed;
    await deletionsClosed;
    await media.waitForSaves();
    await Promise.allSettled([...media.probes,...media.enqueues,...media.previews.values()].map(operation=>operation.done));
    await httpClosed;
    await recorderClosed;
    while(ingestor.busy||media.processing||recorder.pollBusy)await new Promise(resolve=>setTimeout(resolve,30));
    await diagnostics.close();
    store.close();
    await runtime.release();
  })();}};
  return app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp({noRecorder:process.env.NO_RECORDER==='1'});
  const close=app.close.bind(app);
  // Only the standalone backend owns this process. After every tracked task,
  // database and server has closed, release its executable as well: unrelated
  // keep-alive handles must not hold an idle installation open indefinitely.
  app.close=async()=>{await close();process.exit(0);};
  console.log(`录播机已启动：http://127.0.0.1:${app.port}\n素材目录：${app.root}`);
  for(const event of ['SIGINT','SIGTERM'])process.once(event,async()=>{await app.close();process.exit(0);});
}
