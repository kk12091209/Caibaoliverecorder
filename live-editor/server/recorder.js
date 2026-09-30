import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const CHAT_ONLY_CONFIG={
  optionalRecordDanmaku:{hasValue:true,value:true},
  optionalRecordDanmakuSuperChat:{hasValue:true,value:false},
  optionalRecordDanmakuGift:{hasValue:true,value:false},
  optionalRecordDanmakuGuard:{hasValue:true,value:false}
};

export class Recorder {
  constructor(store,{executable,port=17861,editorPort=17860,lifecycle={}}={}) {
    this.store=store;this.executable=executable;this.port=port;this.editorPort=editorPort;
    this.directory=path.join(store.root,'originals');this.rooms=[];this.online=false;this.error='';this.log='';
    this.secret=store.setting('recorder-secret')||randomBytes(24).toString('hex');store.setting('recorder-secret',this.secret);
    this.webhookSecret=store.setting('webhook-secret')||randomBytes(24).toString('hex');store.setting('webhook-secret',this.webhookSecret);
    this.pollBusy=false;this.process=null;this.childRunning=false;this.closed=false;this.monitoring=false;this.starting=null;
    this.failures=0;this.retryAt=0;this.shutdown=new AbortController();
    this.lifecycle={fetch,spawn,now:Date.now,healthMs:2000,retryMs:1000,maxRetryMs:30000,startupMs:30000,startupPollMs:250,requestMs:10000,...lifecycle};
    this.storageEligibilitySince=Date.now();
  }
  assertOpen(){if(this.closed){const error=new Error('录制监控已关闭。');error.code='RECORDER_CLOSED';throw error;}}
  async api(route,body,method=body===undefined?'GET':'POST') {
    this.assertOpen();let response;
    try{response=await this.lifecycle.fetch(`http://127.0.0.1:${this.port}/api/${route}`,{method,headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from('editor:'+this.secret).toString('base64')}`},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.lifecycle.requestMs)])});}
    catch(cause){
      this.assertOpen();const error=new Error(cause.name==='TimeoutError'?'录制核心连接超时，正在尝试恢复。':'录制核心暂时无法连接，正在尝试恢复。',{cause});
      error.connectionRefused=cause.code==='ECONNREFUSED'||cause.cause?.code==='ECONNREFUSED';throw error;
    }
    this.assertOpen();
    if(!response.ok){const error=new Error(response.status===401||response.status===403?'录制核心鉴权失败，请确认没有另一份程序占用录制端口。':`录制核心请求失败：${response.status}`);error.coreStatus=response.status;throw error;}
    const text=await response.text();this.assertOpen();return text?JSON.parse(text):null;
  }
  start() {
    if(this.closed)return Promise.resolve(false);
    this.monitoring=true;this.schedule();return this.ensureReady();
  }
  schedule(){
    if(this.closed||!this.monitoring||this.timer)return;
    this.timer=setTimeout(async()=>{this.timer=null;try{await this.poll();}finally{this.schedule();}},this.lifecycle.healthMs);
  }
  failed(error){
    if(this.closed)return;
    this.online=false;this.error=error.message;this.failures=Math.min(this.failures+1,16);
    this.retryAt=this.lifecycle.now()+Math.min(this.lifecycle.maxRetryMs,this.lifecycle.retryMs*2**(this.failures-1));
  }
  ensureReady(){
    if(this.closed)return Promise.resolve(false);
    if(this.starting)return this.starting;
    if(this.lifecycle.now()<this.retryAt)return Promise.resolve(false);
    this.starting=this.connect().then(()=>{
      if(this.closed)return false;
      this.online=true;this.error='';this.failures=0;this.retryAt=0;return true;
    }).catch(error=>{this.failed(error);return false;}).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async pause(ms){
    if(this.closed)return;
    await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);this.shutdown.signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);this.shutdown.signal.addEventListener('abort',done,{once:true});
    });
  }
  async connect() {
    this.assertOpen();
    if(!this.executable)throw new Error('未配置录制核心，仍可导入本地 FLV 录像。');
    await fs.mkdir(this.directory,{recursive:true});
    this.assertOpen();
    const config=path.join(this.directory,'config.json');
    try{await fs.access(config);}catch{this.assertOpen();
      await fs.writeFile(config,JSON.stringify({version:3,global:{RecordDanmaku:{HasValue:true,Value:true},CuttingMode:{HasValue:true,Value:0},RecordDanmakuFlushInterval:{HasValue:true,Value:0}},rooms:[]},null,2));
    }
    this.assertOpen();
    try{await this.api('room');}catch(error){
      this.assertOpen();
      // A listening but unauthorized/unresponsive core must never cause a second writer.
      if(!error.connectionRefused)throw error;
      if(!this.childRunning)await this.launchCore();
      const deadline=this.lifecycle.now()+this.lifecycle.startupMs;
      while(true){
        this.assertOpen();
        if(!this.childRunning&&this.childFailure)throw this.childFailure;
        try{await this.api('room');break;}catch(probeError){
          this.assertOpen();if(probeError.coreStatus||this.lifecycle.now()>=deadline)throw probeError;
          await this.pause(this.lifecycle.startupPollMs);
        }
      }
    }
    this.assertOpen();
    await this.api('config/global',{
      optionalWebHookUrlsV2:{hasValue:true,value:`http://127.0.0.1:${this.editorPort}/internal/recorder-event?token=${this.webhookSecret}`},
      ...CHAT_ONLY_CONFIG,
      optionalRecordDanmakuFlushInterval:{hasValue:true,value:0},optionalCuttingMode:{hasValue:true,value:0},
      optionalRecordingQuality:{hasValue:true,value:'avc10000,avc400,avc250,avc150,avc80'}
    });
    this.assertOpen();const rooms=await this.api('room');this.assertOpen();
    // Reapply room overrides after each reconnection; the core may have restarted separately.
    for(const room of rooms){this.assertOpen();await this.api(`room/${room.roomId}/config`,CHAT_ONLY_CONFIG);}
    this.assertOpen();this.rooms=rooms;
  }
  async launchCore(){
      try{await fs.access(this.executable);}catch{
        throw new Error('找不到录制核心。请完整解压发布包并保留 runtime/recorder，或通过 RECORDER_PATH 指定录制核心。仍可导入本地 FLV 录像。');
      }
      this.assertOpen();this.childFailure=null;
      const logFd=openSync(path.join(this.store.root,'recorder.log'),'a');
      let child;
      try{child=this.lifecycle.spawn(this.executable,['run','--http-bind',`http://127.0.0.1:${this.port}`,'--http-basic-user','editor','--http-basic-pass',this.secret,'--enable-file-browser','false',this.directory],{windowsHide:true,detached:true,stdio:['ignore',logFd,logFd],env:{...process.env,BREC_SKIP_DISABLE_QUICK_EDIT:'1'}});}finally{closeSync(logFd);}
      this.process=child;this.childRunning=!!child.pid;
      child.on('error',e=>{
        if(this.closed||this.process!==child)return;
        if(!child.pid)this.childRunning=false;
        this.childFailure=new Error(`录制核心无法启动：${e.message}。请检查运行组件是否完整。`);
        if(!this.starting)this.failed(this.childFailure);
      });
      child.on('exit',code=>{
        if(this.closed||this.process!==child)return;
        this.childRunning=false;this.childFailure=new Error(`录制核心已退出 (${code})，正在尝试恢复。`);
        if(!this.starting)this.failed(this.childFailure);
      });
      child.unref();
  }
  async poll(){
    if(this.closed||this.pollBusy)return;this.pollBusy=true;
    try{
      if(!this.online){await this.ensureReady();return;}
      const rooms=await this.api('room');this.assertOpen();this.rooms=rooms;this.error='';
      for(const session of this.store.all("SELECT * FROM sessions WHERE room>0 AND status IN ('recording','waiting')")){
        const room=this.rooms.find(r=>Number(r.roomId)===session.room);
        if(room&&!room.recording&&!room.streaming){this.store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);this.store.run('UPDATE sources SET closed=1 WHERE session=? AND closed=0',session.id);}
      }
      if(!this.lastScan||Date.now()-this.lastScan>10000){
        try{await this.reconcile();if(!this.closed)this.lastScan=Date.now();}
        catch(e){if(!this.closed)this.error=`素材同步失败：${e.message}`;}
      }
    }catch(e){this.failed(e);}finally{this.pollBusy=false;}
  }
  async reconcile(){
    if(this.closed)return;
    // Webhooks are advisory: recover files created while the editor was not running.
    const files=[],recorder=this;
    async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(recorder.closed)return;const full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile()&&/\.flv$/i.test(full))files.push({path:full,stat:await fs.stat(full)});}}
    await walk(this.directory);if(this.closed)return;files.sort((a,b)=>a.stat.birthtimeMs-b.stat.birthtimeMs);
    const newest=new Map();
    for(const file of files){
      if(this.closed)return;
      if(this.store.wasSourceDeleted(file.path))continue;
      let source=this.store.get('SELECT * FROM sources WHERE path=?',file.path);
      if(!source){
        let xml='';try{const handle=await fs.open(file.path.replace(/\.flv$/i,'.xml'),'r');try{const b=Buffer.alloc(16384);const r=await handle.read(b,0,b.length,0);xml=b.subarray(0,r.bytesRead).toString('utf8');}finally{await handle.close();}}catch{}
        if(this.closed)return;
        if(this.store.wasSourceDeleted(file.path))continue;
        const metadata=xml.match(/<BililiveRecorderRecordInfo\s+([^>]+)/)?.[1]||'',attrs={};for(const a of metadata.matchAll(/([\w_]+)="([^"]*)"/g))attrs[a[1]]=a[2];
        const room=Number(attrs.roomid);if(!room)continue;
        const wall=Number.isFinite(Date.parse(attrs.start_time))?attrs.start_time:file.stat.birthtime.toISOString();
        let session=this.store.get("SELECT * FROM sessions WHERE room=? AND status IN ('recording','waiting') ORDER BY created DESC LIMIT 1",room);
        if(!session)session=this.store.createSession({room,title:(attrs.title||`直播间 ${room}`).replace(/&quot;/g,'"').replace(/&amp;/g,'&'),created:wall});
        source=this.store.addSource(session.id,file.path,Math.max(0,(Date.parse(wall)-Date.parse(session.created))/1000),wall,false);
      }
      const session=this.store.session(source.session);if(session)newest.set(session.room,source.id);
    }
    for(const source of this.store.all("SELECT sources.*,sessions.room FROM sources JOIN sessions ON sessions.id=sources.session WHERE sources.closed=0 AND sessions.room>0")){
      const room=this.rooms.find(r=>Number(r.roomId)===source.room);
      if(room&&(!room.recording||newest.get(source.room)!==source.id))this.store.run('UPDATE sources SET closed=1 WHERE id=?',source.id);
    }
  }
  async event(event){
    this.assertOpen();
    if(!event?.EventId||!event.EventData||typeof event.EventId!=='string')throw new Error('录制事件无效。');
    if(this.store.get('SELECT id FROM events WHERE id=?',event.EventId))return;
    const d=event.EventData,type=event.EventType,room=Number(d.RoomId);
    if(!Number.isInteger(room)||room<=0)throw new Error('房间编号无效。');
    if(type==='FileOpening'||type==='FileClosed'){
      const full=path.resolve(this.directory,String(d.RelativePath||''));const relative=path.relative(this.directory,full);
      if(relative.startsWith('..')||path.isAbsolute(relative)||!full.toLowerCase().endsWith('.flv'))throw new Error('录制文件路径无效。');
      if(this.store.wasSourceDeleted(full)){this.store.run('INSERT OR IGNORE INTO events VALUES(?)',event.EventId);return;}
      let source=this.store.get('SELECT * FROM sources WHERE path=?',full);
      if(!source){
        let session=this.store.get("SELECT * FROM sessions WHERE room=? AND status IN ('recording','waiting') ORDER BY created DESC LIMIT 1",room);
        if(!session)session=this.store.createSession({title:d.Title||d.Name||`直播间 ${room}`,room,created:d.FileOpenTime||event.EventTimestamp});
        const start=Math.max(0,session.duration,(Date.parse(d.FileOpenTime||event.EventTimestamp)-Date.parse(session.created))/1000);
        source=this.store.addSource(session.id,full,start,d.FileOpenTime||event.EventTimestamp,type==='FileClosed');
        // Only a new, observed live opening opts into future transient-chunk
        // release. Historical scans, imports and late openings never opt in.
        if(type==='FileOpening'&&source.closed===0&&Number.isFinite(Date.parse(d.FileOpenTime))&&Date.parse(d.FileOpenTime)>=this.storageEligibilitySince)this.store.run("INSERT INTO source_storage(source,eligible) VALUES(?,1) ON CONFLICT(source) DO NOTHING",source.id);
        this.store.run("UPDATE sessions SET status='recording' WHERE id=?",session.id);
      }
      if(type==='FileClosed')this.store.run('UPDATE sources SET closed=MAX(closed,1) WHERE id=?',source.id);
    }else if(type==='SessionEnded'){
      this.store.run("UPDATE sessions SET status=? WHERE room=? AND status IN ('recording','waiting')",d.Streaming?'waiting':'finished',room);
    }else if(type==='StreamEnded'){
      this.store.run("UPDATE sessions SET status='finished' WHERE room=? AND status IN ('recording','waiting')",room);
      this.store.run("UPDATE sources SET closed=1 WHERE closed=0 AND session IN (SELECT id FROM sessions WHERE room=? AND status='finished')",room);
    }
    this.store.run('INSERT OR IGNORE INTO events VALUES(?)',event.EventId);
  }
  async stopRoom(room){await this.api(`room/${room}/stop`,{});this.assertOpen();this.store.run("UPDATE sessions SET status='finishing' WHERE room=? AND status IN ('recording','waiting')",room);}
  async removeRoom(room,confirmed){
    if(confirmed!==true)throw new Error('请先确认是否移除这个监控房间。');
    // Wait for the writer to close before removing the room; Dispose only requests a stop.
    await this.api(`room/${room}/config`,{autoRecord:false});
    this.assertOpen();
    await this.stopRoom(room);
    let stopped=false;
    for(let n=0;n<40;n++){
      const rooms=await this.api('room');this.assertOpen();
      if(!rooms.find(r=>Number(r.roomId)===room)?.recording){stopped=true;break;}
      await this.pause(250);this.assertOpen();
    }
    if(!stopped)throw new Error('已关闭自动录制，录制核心仍在收尾，请稍后重试移除。');
    await this.api(`room/${room}`,undefined,'DELETE');
    this.assertOpen();
    this.store.run("UPDATE sessions SET status='finishing' WHERE room=? AND status IN ('recording','waiting')",room);
    this.store.run('UPDATE sources SET closed=1 WHERE closed=0 AND session IN (SELECT id FROM sessions WHERE room=?)',room);
    await this.poll();
  }
  close(){
    this.closed=true;this.monitoring=false;clearTimeout(this.timer);this.timer=null;this.shutdown.abort();
    // Only monitoring stops. The independent core keeps recording across editor restarts.
    this.process?.unref();
  }
}

export function roomNumber(value){
  const text=String(value).trim(); if(/^\d+$/.test(text)&&Number(text)>0)return Number(text);
  let url;try{url=new URL(text);}catch{throw new Error('请输入 B 站直播间链接或房间号。');}
  if(url.hostname!=='live.bilibili.com')throw new Error('首版仅支持 B 站直播间。');
  const id=url.pathname.match(/^\/(?:blanc\/)?(\d+)/)?.[1];if(!id||Number(id)<=0)throw new Error('链接中没有有效的直播间号。');return Number(id);
}

export async function resolveRoom(value){
  const text=String(value).trim(),link=text.match(/https?:\/\/[^\s<>]+/)?.[0]||text;
  if(/^\d+$/.test(link))return roomNumber(link);
  let url;try{url=new URL(link);}catch{throw new Error('请输入 B 站直播链接或房间号。');}
  for(let attempt=0;attempt<5;attempt++){
    if(url.hostname==='live.bilibili.com')return roomNumber(url.href);
    if(url.hostname!=='b23.tv'||!['https:','http:'].includes(url.protocol)||url.port)throw new Error('首版仅支持 B 站直播链接和 b23.tv 分享链接。');
    const response=await fetch(url,{redirect:'manual',headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(12000)});
    const next=response.headers.get('location');await response.body?.cancel();
    if(!next)throw new Error('分享链接未返回直播间，请改用 live.bilibili.com 的完整链接。');
    url=new URL(next,url);
  }
  throw new Error('分享链接跳转次数过多，请使用完整直播间链接。');
}
