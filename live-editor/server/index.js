import { closeAppWith, recoverAppTasks } from './app-lifecycle.js';
import { appActivity, hasRecording, hasIndexing } from './app-activity.js';
import { workbenchSettings, workbenchSnapshot } from './workbench-snapshot.js';
import { json, body, sendFile } from './http-response.js';
import { handleSystemRoutes } from './system-routes.js';
import { handleSettingsRoutes } from './settings-routes.js';
import { handleMaterialRoutes } from './material-routes.js';
import { LotteryRecorder } from './lottery-records.js';
import fs from 'node:fs/promises';
import {requireLocalAccess} from './local-access.js';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecoveredStore } from './data-recovery.js';
import { Ingestor } from './ingest.js';
import {GiftIcons} from './gift-icons.js';
import { CompactStorage } from './compact-storage.js';
import { Media } from './media.js';
import { MAX_FONT_BYTES } from './danmaku-font.js';
import { BackgroundPreparation } from './background-preparation.js';
import {validCacheWarningGiB,validCacheWarningThreshold,acknowledgeCacheWarning} from './preparation-cache-warning.js';
import {validCacheWarningGB,cacheWarningInGiB} from '../shared/cache-warning-units.js';
import {ui} from '../shared/ui-copy.js';
import { LiveRecordingHealth } from './live-recording-health.js';
import { LivePreparationPolicy } from './live-preparation-policy.js';
import { liveSystemResources } from './live-system-resources.js';
import { JobDeletion } from './job-deletion.js';
import { DeletionMaintenance } from './deletion-maintenance.js';
import { SessionDeletion } from './session-deletion.js';
import { WaveformService } from './waveform.js';
import { DensityService } from './density.js';
import { MultiPlatformRecorder } from './multi-platform-recorder.js';
import { resolveRuntimeTool, resolveProjectRoot } from './runtime-paths.js';
import { ServiceRuntime } from './service-runtime.js';
import { DesktopExit } from './desktop-exit.js';
import { Updates } from './updates.js';
import { AutoUpdate } from './auto-update.js';
import { DailyDiagnostics } from './diagnostics.js';
import { listenLocal } from './local-endpoint.js';
import { DanmakuStylePreview } from './danmaku-style-preview.js';
import { LinkmicIndex } from './linkmic.js';
import {PlatformCredentials,COOKIE_PLATFORMS} from './platform-credentials.js';
import {PlatformCookieValidation} from './platform-cookie-validation.js';

const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function createApp(options={}) {
  const root=path.resolve(options.data??process.env.EDITOR_DATA??path.join(appRoot,'data'));
  options.onStartup?.('检查数据目录与已有后台');
  const runtime=await ServiceRuntime.acquire(root,appRoot,{managed:options.desktopManaged??process.env.EDITOR_DESKTOP_MANAGED==='1',...options.runtimeOptions});
  runtime.onStartup=options.onStartup;
  try{
    const packageInfo=JSON.parse(await fs.readFile(path.join(appRoot,'package.json'),'utf8'));
    runtime.diagnostics=await DailyDiagnostics.open(root,{version:packageInfo.version,...options.diagnosticOptions});
    runtime.diagnostics.protectSecret(runtime.token);
    if(runtime.leaseRecovered)runtime.diagnostics.record('数据恢复','异常后台锁已隔离并重新建立；原素材保留',{level:'警告',important:true});
    await runtime.startup('初始化运行日志');
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
  await runtime.startup('打开素材数据库');
  const store=await openRecoveredStore(root,diagnostics);
  const credentials=await new PlatformCredentials(root,{diagnostics,...options.credentialOptions,store}).initialize();
  if(options.defaultExportRoot||process.env.EDITOR_EXPORT_ROOT)store.defaultExportRoot=path.resolve(options.defaultExportRoot||process.env.EDITOR_EXPORT_ROOT);
  store.projectRoot=path.resolve(options.projectRoot??(options.data?path.dirname(root):projectRoot));
  const ingestor=new Ingestor(store),media=new Media(store,{ffmpeg,ffprobe}),storage=new CompactStorage(store),jobDeletion=new JobDeletion(store);
  store.giftIcons=new GiftIcons(store,{ffmpeg});
  const waveform=new WaveformService(store,media),density=new DensityService(store),stylePreview=new DanmakuStylePreview(media);
  store.density=density;
  const recorder=new MultiPlatformRecorder(store,{credentials,executable,port:Number(options.recorderPort??process.env.RECORDER_PORT??0),editorPort:port,douyin:options.douyin,xiaohongshu:options.xiaohongshu,douyinFollow:options.douyinFollow,bilibiliResolver:options.bilibiliResolver});
  const lotteries=new LotteryRecorder(store,options.lotteryOptions);
  const cookieValidation=new PlatformCookieValidation(credentials,recorder.platforms,{diagnostics});
  const credentialSnapshot=()=>({...credentials.snapshot(),checks:Object.fromEntries(COOKIE_PLATFORMS.map(platform=>[platform,cookieValidation.status(platform)])),bilibiliCore:{...recorder.bilibili.credentialStatus}});
  media.isRecording=()=>hasRecording(store,recorder);
  const linkmic=new LinkmicIndex(store,{resolver:recorder.douyin.resolver,ffmpeg});store.linkmic=linkmic;
  const clients=new Set(); let closing=false,app,startupRecovery;
  store.recovery.recovering=true;
  const deletingSessions=new SessionDeletion({store,storage,waveform,media,density,idleMs:options.deletionIdleMs??30000,retryMs:options.deletionRetryMs??1000});
  let autoUpdate;
  const liveOptions=options.preparationOptions?.liveOptions||{},liveResources=liveOptions.resources||liveSystemResources();
  const liveHealth=new LiveRecordingHealth({store,recorder,ingestor,media,resources:liveResources,
    blocked:()=>closing||store.recovery.recovering||autoUpdate?.applying||storage.busy||
      (!options.noRecorder&&recorder.connectionPending)||media.hasForegroundWork?.()||
      hasIndexing(store)});
  const preparation=new BackgroundPreparation(store,media,{
    ...options.preparationOptions,
    liveOptions:{...liveOptions,context:liveOptions.context||(()=>liveHealth.context()),policy:liveOptions.policy||new LivePreparationPolicy({resources:liveResources})},
    busyReason:()=>{
      if(closing||store.recovery.recovering||autoUpdate?.applying)return 'foreground';
      if(!options.noRecorder&&recorder.connectionPending)return 'connection';
      if(media.hasForegroundWork?.({includeInteractive:false}))return 'export';
      if(storage.busy)return 'compaction';
      if(hasIndexing(store))return 'indexing';
      if(hasRecording(store,recorder))return 'recording';
      return '';
    }
  });
  void media.renderCache.loadAll().catch(error=>diagnostics.record('缓存目录检查',error,{level:'警告'}));
  media.preparation=preparation;store.preparation=preparation;store.renderCache=media.renderCache;
  store.temporaryWorkspaces=media.temporaryWorkspaces;
  const closeAction=()=>{const saved=store.setting('window-close-action');return ['exit','background'].includes(saved)?saved:'ask';};
  const previewTimestamp=()=>store.setting('preview-timestamp')===true;
  const settingsSnapshot=()=>workbenchSettings(store,media,closeAction,previewTimestamp);
  function validateCloseAction(value){if(!['ask','exit','background'].includes(value))throw new Error('请选择有效的关闭窗口方式。');}
  const activity=()=>appActivity({store,media,recorder,preparation,storage,ingestor,deletingSessions});
  const packageInfo=JSON.parse(await fs.readFile(path.join(appRoot,'package.json'),'utf8'));
  const updates=new Updates(store,{current:{version:packageInfo.version,revision:packageInfo.buildRevision||1},activity,...options.updateOptions});
  await runtime.startup('检查上次更新状态');
  try{await updates.recover();}
  catch(error){liveHealth.close();await updates.close();media.close();await recorder.close();await credentials.close();store.close();throw error;}
  const desktopExit=new DesktopExit({runtime,activity,recorder,media,preparation,close:()=>app.close()});
  const deleteMaterial=(id,options)=>deletingSessions.delete(id,options);
  const deletionMaintenance=new DeletionMaintenance(store,{remove:deleteMaterial,busy:()=>closing||deletingSessions.size>0||ingestor.busy||storage.busy||waveform.active||!!preparation.active||media.previews.size>0||media.hasForegroundWork()||recorder.rooms.some(room=>room.recording)||!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status<>'finished' LIMIT 1")});
  autoUpdate=new AutoUpdate({updates,runtime,appRoot,projectRoot,activity,quit:()=>desktopExit.request(false)});
  const snapshot=()=>workbenchSnapshot({
    store,recorder,diagnostics,updates,preparation,deletingSessions,root,settingsSnapshot,credentialWarnings:credentials.warnings()
  });
  const server=http.createServer(async(req,res)=>{
    try {
      let match;
      const host=req.headers.host||'';
      if(!new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(host)){json(res,{error:'无效的本机访问地址。'},403);return;}
      const url=new URL(req.url,`http://${host}`),p=url.pathname;
      const request={req,res,url,p};
      // Record only the operation name, never query strings or request bodies.
      if(req.method==='POST'&&p.startsWith('/api/'))res.once('finish',()=>{const parts=p.split('/');diagnostics.record('操作结果',`${parts[2]} / ${parts.length>4?parts.at(-1):''}；HTTP ${res.statusCode}`,{level:res.statusCode>=400?'警告':'信息'});});
      if(req.headers.origin && req.headers.origin!==`http://${host}`){json(res,{error:'不允许跨站请求。'},403);return;}
      if(p!=='/internal/desktop'&&p!=='/internal/recorder-event'&&!requireLocalAccess(req,res,runtime))return;
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
      if(store.recovery.recovering&&req.method==='POST'&&p.startsWith('/api/')&&!['/api/folders/open'].includes(p))return json(res,{error:'正在恢复上次任务，请稍候；原始素材已保留。'},503);
      if((runtime.stopping||autoUpdate.applying)&&req.method==='POST'&&p!=='/internal/recorder-event')return json(res,{error:'后台正在安全切换，请稍后再试。'},503);
      if(await handleSystemRoutes(request,{updates,credentials,recorder,cookieValidation,credentialSnapshot}))return;
      if((match=/^\/api\/danmaku-font\/([a-f0-9]{64})$/.exec(p))&&req.method==='GET')return await sendFile(req,res,await media.fonts.file({id:match[1]}));
      if((p==='/api/danmaku-font'||p==='/api/danmaku-font/draft')&&req.method==='POST'){
        const draft=p.endsWith('/draft');let imported;
        if(media.fonts.changing)throw new Error('正在保存字体，请稍后重试。');
        media.fonts.changing=true;
        try{
          if(req.headers['content-type']==='application/octet-stream'){
            const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>MAX_FONT_BYTES)throw new Error('字体超过 32 MB。');chunks.push(chunk);}imported=await media.fonts.import(Buffer.concat(chunks),{select:!draft});
          }else{if(draft)throw new Error('草稿字体请上传字体文件。');const input=await body(req);if(input.reset!==true)throw new Error('字体设置无效。');media.fonts.reset();}
          if(!draft)for(const {session} of store.all('SELECT session FROM preparation_jobs'))await preparation.invalidate(session);
          return json(res,{font:draft?imported:media.fonts.snapshot()});
        }finally{media.fonts.changing=false;}
      }
      if(p==='/api/state'&&req.method==='GET')return json(res,snapshot());
      if(p==='/api/events'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(snapshot())}\n\n`);clients.add(res);res.on('close',()=>clients.delete(res));return;
      }
      if(p==='/internal/recorder-event'&&req.method==='POST'){
        if(url.searchParams.get('token')!==recorder.bilibili.webhookSecret)return json(res,{error:'无效事件来源。'},403);
        await recorder.bilibili.event(await body(req));return json(res,{ok:true});
      }
      if(p==='/api/follow-users'&&req.method==='POST')return json(res,await recorder.douyin.following.add((await body(req)).url));
      if(p==='/api/anchors'&&req.method==='POST')return json(res,await recorder.addAnchor(await body(req)));
      const anchorAction=p.match(/^\/api\/anchors\/((?:bilibili|douyin(?:-user)?|xiaohongshu):\d{1,20}|xiaohongshu-user:[a-f0-9]{24})\/(start|stop|remove)$/);
      if(anchorAction&&req.method==='POST'&&recorder.platformForAnchor(anchorAction[1])){await recorder.anchorAction(anchorAction[1],anchorAction[2],await body(req));return json(res,{anchors:recorder.anchors});}
      const followAction=p.match(/^\/api\/follow-users\/(\d{1,20})\/(enable|remove)$/);
      if(followAction&&req.method==='POST'){const input=await body(req);if(followAction[2]==='enable')await recorder.douyin.following.enable(followAction[1],input.enabled);else await recorder.douyin.following.remove(followAction[1],input.confirmed);return json(res,{following:recorder.douyin.followingSnapshot});}
      if(p==='/api/rooms'&&req.method==='POST'){
        const input=await body(req),result=await recorder.addRoom(input);diagnostics.record('用户操作',`添加监控；平台 ${result?.platform||'bilibili'}；房间 ${result?.roomId||result?.webRid||'见房间状态'}；自动录制=${input.autoRecord!==false}`);return json(res,result);
      }

      if(p==='/api/preparation/settings'&&req.method==='POST'){
        const input=await body(req);
        if(!input||Array.isArray(input)||typeof input!=='object'||!Object.keys(input).length||Object.keys(input).some(key=>!['enabled','liveEnabled','cacheWarningGiB','cacheWarningGB','cacheWarningEnabled'].includes(key)))throw new Error('预处理设置无效。');
        if('enabled' in input&&typeof input.enabled!=='boolean')throw new Error('请选择是否开启录制完成后的自动预处理。');
        if('liveEnabled' in input&&typeof input.liveEnabled!=='boolean')throw new Error('请选择是否开启录制时的自动提前处理。');
        if('cacheWarningGiB' in input&&(!validCacheWarningGiB(input.cacheWarningGiB)||'cacheWarningGB' in input))throw new Error(ui.cacheWarning.阈值无效);
        if('cacheWarningGB' in input&&!validCacheWarningGB(input.cacheWarningGB))throw new Error(ui.cacheWarning.阈值无效);
        if('cacheWarningEnabled' in input&&typeof input.cacheWarningEnabled!=='boolean')throw new Error(ui.cacheWarning.开关无效);
        if('cacheWarningGiB' in input)store.setting('preparationCacheWarningGiB',input.cacheWarningGiB);
        if('cacheWarningGB' in input)store.setting('preparationCacheWarningGiB',cacheWarningInGiB(input.cacheWarningGB));
        if('cacheWarningEnabled' in input)store.setting('preparationCacheWarningEnabled',input.cacheWarningEnabled);
        if('enabled' in input)await preparation.setEnabled(input.enabled);
        if('liveEnabled' in input)await preparation.setLiveEnabled(input.liveEnabled);
        return json(res,preparation.snapshot());
      }
      if(p==='/api/preparation/cache/acknowledge'&&req.method==='POST'){
        const input=await body(req);
        if(!input||!Number.isSafeInteger(input.cycle)||input.cycle<1||!validCacheWarningThreshold(input.thresholdGiB))throw new Error(ui.cacheWarning.确认无效);
        await media.renderCache.loadAll();
        acknowledgeCacheWarning(store,media.renderCache.snapshot(),input);
        return json(res,preparation.snapshot());
      }
      if(p==='/api/preparation/cache/clear'&&req.method==='POST'){
        await preparation.yieldForForeground();
        await media.discardPendingPreparation();await media.renderCache.loadAll();
        const sessions=new Set([...media.renderCache.entries.values()].map(entry=>entry.spec.sessionId));
        const result=await media.renderCache.prune({targetBytes:0});
        for(const id of sessions){
          await preparation.pause(id);
          store.run("UPDATE preparation_jobs SET prepared_seconds=0,bytes=0 WHERE session=?",id);
        }
        diagnostics.record('预处理缓存','清理可重建缓存；已保留使用中及无法确认归属的文件');
        return json(res,{...preparation.snapshot(),cleanup:result});
      }
      if(p==='/api/interaction'&&req.method==='POST'){
        // Short-lived priority only; an open but idle editor does not block preparation.
        preparation.notBefore=Math.max(preparation.notBefore,Date.now()+3000);
        void preparation.yieldForForeground();return json(res,{ok:true});
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
      if((match=/^\/api\/rooms\/(\d+|(?:douyin|xiaohongshu):\d{1,20})\/(start|stop|auto|remove)$/.exec(p))&&req.method==='POST'){
        const input=await body(req);diagnostics.record('用户操作',`直播间 ${match[1]}：${{start:'手动开始录制',stop:'停止录制与监控',auto:'设置自动录制',remove:'移除监控'}[match[2]]}${match[2]==='auto'?`；启用=${input.enabled===true}`:''}`);try{await recorder.action(match[1],match[2],input);diagnostics.record('监控操作完成',`直播间 ${match[1]}：${match[2]} 已成功执行`);}catch(error){diagnostics.record(`直播间 ${match[1]} ${match[2]} 操作失败`,error,{level:'错误'});throw error;}return json(res,{ok:true});
      }
      if(await handleSettingsRoutes(request,{store,media,stylePreview,settingsSnapshot,validateCloseAction,recorder,preparation}))return;
      if(await handleMaterialRoutes(request,{store,media,preparation,deletingSessions,deleteMaterial,recorder,jobDeletion,waveform,density,linkmic}))return;
      if(p.startsWith('/api/')||p.startsWith('/internal/'))return json(res,{error:'接口不存在。'},404);
      if(!['GET','HEAD'].includes(req.method))return json(res,{error:'请求方式无效。'},405);
      const dist=path.join(appRoot,'dist');let target=path.resolve(dist,'.'+decodeURIComponent(p));
      if(!target.startsWith(dist+path.sep)&&target!==dist)return json(res,{error:'无效路径。'},403);
      if(p==='/'||!path.extname(target))target=path.join(dist,'index.html');
      return await sendFile(req,res,target);
    }catch(e){if(e.code!=='PREVIEW_CANCELLED')diagnostics.record('请求处理',e,{level:'错误'});if(!res.headersSent&&!res.destroyed)json(res,{error:e.code==='ENOENT'?'文件不存在，请检查路径或先构建界面。':e.message},e.status||400);else if(!res.writableEnded)res.destroy();}
  });
  await runtime.startup('连接本地界面服务');
  try{port=await listenLocal(server,port);}
  catch(error){liveHealth.close();media.close();await recorder.close();await credentials.close();store.close();throw error;}
  port=server.address().port;recorder.bilibili.editorPort=port;
  try{await runtime.publish(port);await runtime.startup('本地界面服务已就绪',{ready:true});}
  catch(error){liveHealth.close();media.close();await recorder.close();await media.waitForSaves();await new Promise(resolve=>server.close(resolve));await credentials.close();store.close();throw error;}

  let nextTemporarySweep=0;
  const maintain=()=>{
    if(closing||store.recovery.recovering||autoUpdate.applying)return;
    void deletionMaintenance.tick().catch(error=>{deletionMaintenance.lastError=error.message;diagnostics.record('自动清理',error,{level:'警告'});});
    if(options.compact!==false)void storage.tick().catch(error=>{storage.lastError=error.message;diagnostics.record('素材整理',error,{level:'警告'});});
    if(Date.now()>=nextTemporarySweep){nextTemporarySweep=Date.now()+60000;void media.cleanupStaleTemporary().catch(error=>{media.temporaryCleanupError=error.message;diagnostics.record('缓存清理',error,{level:'警告'});});}
  };
  const maintenanceTimer=setInterval(maintain,5000);
  const runtimeTimer=setInterval(()=>{
    if(closing)return;
    const current=activity();if(!runtime.shouldStop(current))return;
    runtime.stopping=true;
    diagnostics.record('后台退出判定',JSON.stringify({reason:runtime.pending?'收到 '+runtime.pending+' 请求':'无后台任务且桌面心跳已失效',
      busy:current.busy,background:current.background,clients:runtime.liveClients()}),{important:true});
    void(async()=>{
      if(runtime.pending!=='restart'&&!options.noRecorder&&!await recorder.stopIdle()){runtime.stopping=false;return;}
      await app.close();
    })().catch(error=>{runtime.stopping=false;runtime.lastError=error.message;diagnostics.record('退出',error,{level:'错误'});});
  },options.runtimePollMs??1000);
  maintain();
  if(options.updatesAutoCheck??runtime.managed)updates.start();
  const timer=setInterval(()=>{
    try{
    if(closing||store.recovery.recovering)return;
    for(const s of store.all("SELECT * FROM sessions WHERE status IN ('importing','finishing')")){
      const sources=store.sources(s.id);if(sources.length&&sources.every(x=>x.closed===2))store.run("UPDATE sessions SET status='finished' WHERE id=?",s.id);
    }
    if(clients.size){const message=`data: ${JSON.stringify(snapshot())}\n\n`;for(const client of clients)if(!client.writableNeedDrain)client.write(message);}
    }catch(error){diagnostics.record('界面状态推送',error,{level:'错误'});}
  },1000);
  const diagnosticPoll=()=>{
    if(closing)return;
    if(!options.noRecorder)void cookieValidation.tick().catch(()=>{
      diagnostics.record('Cookie 校验','暂时未能刷新弹幕登录状态，将在后续检查时重试。',{level:'警告'});
    });
    try{
      diagnostics.rooms(recorder.rooms,{biliOnline:recorder.bilibili.online});
      diagnostics.observe('core',`B站核心：${recorder.bilibili.online?'已连接':recorder.bilibili.error||'正在连接'}`,recorder.bilibili.online?'信息':'警告');
      diagnostics.observe('activity',`后台工作：${activity().reason||'空闲'}`);
      for(const source of store.all('SELECT id,error,closed FROM sources ORDER BY rowid DESC LIMIT 16'))if(source.error)diagnostics.observe('source:'+source.id,`素材 ${source.id} 错误：${source.error}`,'错误');
      for(const job of store.all('SELECT id,status,error FROM jobs ORDER BY rowid DESC LIMIT 32'))diagnostics.observe('job:'+job.id,`导出 ${job.id}：${job.status}${job.error?'；'+job.error:''}`,job.error?'错误':'信息');
      for(const item of preparation.snapshot().items)if(['space','disk','capacity','space-check'].includes(item.reason)||item.status==='error')diagnostics.observe('preparation:'+item.session,`预处理 ${item.session}：${item.status}；原因 ${item.reason||'error'}；${item.error||''}；缓存 ${JSON.stringify(media.renderCache.snapshot())}`,['space','disk','capacity','space-check'].includes(item.reason)||item.error?'警告':'信息');
      if(runtime.quitError)diagnostics.observe('quit-error',`退出未完成：${runtime.quitError}`,'错误');
      void diagnostics.tick();
    }catch(error){diagnostics.record('运行检查',error,{level:'错误'});}
  };
  const diagnosticTimer=setInterval(diagnosticPoll,30000);diagnosticPoll();
  if(!options.noRecorder){void recorder.start().catch(e=>{recorder.bilibili.error=e.message;});}
  const close=closeAppWith({
    beginClosing:()=>{closing=true;cookieValidation.close();}, timers:[timer,maintenanceTimer,runtimeTimer,diagnosticTimer],
    liveHealth,lotteries,updates,ingestor,media,recorder,linkmic,deletionMaintenance,deletingSessions,
    preparation,waveform,density,clients,server,storage,getStartupRecovery:()=>startupRecovery,
    credentials,diagnostics,store,runtime,
  });
  app={credentials,cookieValidation,diagnostics,updates,store,ingestor,media,storage,waveform,density,preparation,deletionMaintenance,deletingSessions,recorder,lotteries,runtime,desktopExit,activity,server,port,root,snapshot,close};
  startupRecovery=recoverAppTasks({
    diagnostics,media,store,isClosing:()=>closing,ingestor,preparation,lotteries,options,maintain,
  });
  app.startupRecovery=startupRecovery;
  return app;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp({noRecorder:process.env.NO_RECORDER==='1',onStartup:phase=>console.log(`[${new Date().toISOString()}] [启动阶段] ${phase}`)});
  const close=app.close.bind(app);
  // Only the standalone backend owns this process. After every tracked task,
  // database and server has closed, release its executable as well: unrelated
  // keep-alive handles must not hold an idle installation open indefinitely.
  app.close=async()=>{await close();process.exit(0);};
  console.log(`录播机已启动：http://127.0.0.1:${app.port}\n素材目录：${app.root}`);
  // Recovery uses the same durable shutdown as an explicit desktop quit:
  // suspend exports and stop recording before releasing this process.
  for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{
    app.diagnostics.record('后台恢复',`收到 ${event} 停止请求；保存任务状态后安全退出`,{important:true});
    void app.desktopExit.request(true).catch(error=>app.diagnostics.record('后台恢复',error,{level:'错误',important:true}));
  });
}
