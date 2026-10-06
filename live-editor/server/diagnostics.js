import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const LOG_MAX_BYTES=512*1024, LOG_RETENTION_DAYS=30;
const stamp=ms=>new Date(ms+8*3600000).toISOString().replace('T',' ').replace('Z',' +08:00');
export const logDay=ms=>stamp(ms).slice(0,10);
// No request bodies, cookies, chat text or stream URLs are intentionally logged.
// This is a second defence for errors originating in third-party components.
export function safeLog(value,depth=0,secrets=[]){
  if(value instanceof Error){const detail=`${safeLog(value.name,depth,secrets)}${value.code?' ['+safeLog(value.code,depth,secrets)+']':''}${value.cause?.code?' [原因 '+safeLog(value.cause.code,depth,secrets)+']':''}: ${safeLog(value.message,depth,secrets)}`;return (detail+(value.cause&&depth<2?'；原因：'+safeLog(value.cause,depth+1,secrets):'')).slice(0,1600);}
  let text=String(value??'');for(const secret of secrets)text=text.replaceAll(secret,'[已隐藏]');
  text=text.replace(/\x1b\[[0-9;]*m/g,'').replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,'[链接已隐藏]')
    .replace(/(?:authorization["']?\s*[:=]\s*["']?\s*(?:basic|bearer)?|cookie["']?\s*[:=]|set-cookie["']?\s*[:=])[^\r\n]*/gi,'[认证信息已隐藏]')
    .replace(/((?:password|passwd|token|secret|sessdata|bili_jct|sessionid|credential|signature|access[_-]?key)\s*["']?\s*[:=]\s*)[^\s,;，；]+/gi,'$1[已隐藏]')
    .replace(/(?:\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/g,'[用户目录]')
    .replace(/[\x00-\x1f\x7f]+/g,' ');
  return text.slice(0,1600);
}
export function recordingReason(room,{biliOnline=true}={}){
  if(room.recording)return '正在录制';
  if(room.recordingEnabled===false)return '用户未启用录制或已停止；不会自动开始';
  if(room.error)return `录制或平台连接异常：${safeLog(room.error)}`;
  if(room.platform!=='douyin'&&!biliOnline)return 'B站录制核心未连接；正在重连，暂时无法确认开播状态';
  if(room.streaming!==true)return '当前未检测到开播；保持监控';
  if(room.recordingEnabled!==true&&room.autoRecord!==true&&room.autoRecordForThisSession!==true)return '未开启自动录制，也未启动本场录制';
  return '已开播且录制已启用，但尚未观察到录制；可能正在准备或重试，原因暂未确定';
}

export class DailyDiagnostics{
  static async open(root,options={}){
    const log=new DailyDiagnostics(root,options);await log.initialize();return log;
  }
  constructor(root,{now=Date.now,io=fs,version='unknown',maxBytes=LOG_MAX_BYTES,retentionDays=LOG_RETENTION_DAYS}={}){
    Object.assign(this,{now,io,version,maxBytes,retentionDays});
    this.directory=path.join(root,'logs');this.stateFile=path.join(this.directory,'.daily-state.json');
    this.pending=Promise.resolve();this.queued=0;this.dropped=0;this.repeat=new Map();this.observed=new Map();this.desktops=new Map();
    this.secrets=new Set();this.lastError='';this.closed=false;this.day=logDay(now());this.started=now();this.counts={events:0,warnings:0,errors:0};
  }
  protectSecret(value){if(typeof value==='string'&&value.length>=8&&this.secrets.size<16)this.secrets.add(value);}
  redact(value){return safeLog(value,0,this.secrets);}
  enqueue(task){
    if(this.queued>=128){this.dropped++;return this.pending;}
    this.queued++;
    this.pending=this.pending.then(task).catch(error=>{this.lastError=this.redact(error);}).finally(()=>this.queued--);
    return this.pending;
  }
  async initialize(){
    await this.enqueue(async()=>{
      await this.io.mkdir(this.directory,{recursive:true,mode:0o700});
      let previous;try{previous=JSON.parse(await this.io.readFile(this.stateFile,'utf8'));}catch{}
      if(previous&&/^\d{4}-\d{2}-\d{2}$/.test(previous.day)){
        if(previous.day===this.day&&previous.counts)this.counts={events:Number(previous.counts.events)||0,warnings:Number(previous.counts.warnings)||0,errors:Number(previous.counts.errors)||0};
        if(previous.clean===false)await this.append(previous.day,`[${stamp(this.now())}] [警告] 上次运行未留下正常退出记录；最后存活记录：${safeLog(previous.lastSeen)}。可能是强制结束、断电或进程异常，不能据此确定具体原因。下次启动补记。\n`,true);
        if(previous.day!==this.day)await this.append(previous.day,`[${stamp(this.now())}] [汇总] 下次启动补记：该使用日已结束；累计事件 ${Number(previous.counts?.events)||0}，警告 ${Number(previous.counts?.warnings)||0}，错误 ${Number(previous.counts?.errors)||0}。\n`,true);
      }
      await this.prune();
      await this.writeState(false);
      await this.append(this.day,`[${stamp(this.now())}] [信息] 后台启动；版本 ${safeLog(this.version)}；系统 ${process.platform}/${process.arch}；Node ${process.versions.node}；PID ${process.pid}。\n`,true);
    });
    return this;
  }
  async append(day,line,important=false){
    if(Buffer.byteLength(line)>4096){const prefix=Buffer.from(line).subarray(0,4000).toString('utf8');line=prefix+'…（长记录已截断）\n';}
    const file=path.join(this.directory,`${day}.txt`);
    let size=0;try{size=(await this.io.stat(file)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!size){const header=`菜播·录包机运行日志 — ${day}（北京时间 UTC+8）\n仅记录状态、操作和错误；不记录弹幕正文、认证信息或直播流链接。\n文件最多 512 KiB；密集重复记录合并，超过上限会省略普通记录。\n\n`;await this.io.writeFile(file,header,{mode:0o600});size=Buffer.byteLength(header);}
    const bytes=Buffer.byteLength(line),limit=important?this.maxBytes:this.maxBytes-16384;
    if(size+bytes>limit){
      if(!important){this.dropped++;return;}
      // Keep the beginning and newest lifecycle events even on an unusually busy day.
      const old=await this.io.readFile(file,'utf8'),headBudget=this.maxBytes-8192;
      const head=Buffer.from(old).subarray(0,headBudget).toString('utf8').split('\n').slice(0,-1).join('\n');
      const tail=Buffer.from(old).subarray(-4096).toString('utf8').split('\n').slice(1).join('\n');
      await this.io.writeFile(file,head+'\n[汇总] 文件达到上限；中间部分记录已省略。\n'+tail+line,{mode:0o600});return;
    }
    await this.io.appendFile(file,line,{mode:0o600});
  }
  async writeState(clean){
    await this.io.mkdir(this.directory,{recursive:true,mode:0o700});
    const temporary=this.stateFile+'.next';
    await this.io.writeFile(temporary,JSON.stringify({day:this.day,started:stamp(this.started),lastSeen:stamp(this.now()),clean,counts:this.counts}),{mode:0o600});
    await this.io.rename(temporary,this.stateFile);this.lastError='';
  }
  async prune(){
    const cutoff=logDay(this.now()-(this.retentionDays-1)*86400000);
    for(const name of await this.io.readdir(this.directory))if(/^\d{4}-\d{2}-\d{2}\.txt$/.test(name)&&name.slice(0,10)<cutoff)await this.io.unlink(path.join(this.directory,name));
  }
  async rotate(day){
    if(day===this.day)return;
    await this.flushRepeats();await this.summary('跨日汇总');
    this.day=day;this.counts={events:0,warnings:0,errors:0};this.repeat.clear();
    await this.prune();await this.writeState(false);
    await this.append(day,`[${stamp(this.now())}] [信息] 应用持续运行，已切换到当天日志。\n`,true);
  }
  record(component,message,{level='信息',important=false}={}){
    if(this.closed)return this.pending;
    const at=this.now(),day=logDay(at),text=this.redact(message),source=this.redact(component).slice(0,80);
    return this.enqueue(async()=>{
      await this.rotate(day);this.counts.events++;if(level==='警告')this.counts.warnings++;if(level==='错误')this.counts.errors++;
      const key=source+'|'+level+'|'+text,previous=this.repeat.get(key);
      if(previous&&at-previous.at<60000&&!important){previous.count++;return;}
      if(previous?.count)await this.append(day,`[${stamp(at)}] [${level}] ${source}：${text}（此前相同记录重复 ${previous.count} 次）。\n`);
      if(this.repeat.size>=256&&!this.repeat.has(key)){await this.flushRepeats();this.repeat.clear();}
      this.repeat.set(key,{at,count:0,source,level,text});
      await this.append(day,`[${stamp(at)}] [${level}] ${source}：${text}\n`,important);
    });
  }
  async flushRepeats(){
    for(const item of this.repeat.values())if(item.count){await this.append(this.day,`[${stamp(this.now())}] [${item.level}] ${item.source}：${item.text}（相同记录又出现 ${item.count} 次，已合并）。\n`);item.count=0;}
  }
  async summary(label){
    await this.append(this.day,`[${stamp(this.now())}] [汇总] ${label}：累计事件 ${this.counts.events}，警告 ${this.counts.warnings}，错误 ${this.counts.errors}；队列或文件上限省略 ${this.dropped} 条。\n`,true);this.dropped=0;
  }
  desktop(client,pid,kind='desktop'){
    if(kind!=='desktop'||this.desktops.has(client))return;
    if(this.desktops.size>=64)this.desktops.delete(this.desktops.keys().next().value);
    this.desktops.set(client,pid);this.record('桌面','打开应用；PID '+pid,{important:true});
  }
  observe(key,message,level='信息'){
    const day=logDay(this.now());if(this.observedDay!==day){this.observedDay=day;this.observed.clear();}
    if(this.observed.get(key)===message)return;
    if(this.observed.size>=256&&!this.observed.has(key))this.observed.delete(this.observed.keys().next().value);
    this.observed.set(key,message);this.record('状态变化',message,{level});
  }
  rooms(rooms,context){
    const keep=new Set();
    for(const room of rooms.slice(0,64)){
      const id=`room:${room.platform||'bilibili'}:${room.roomId}`;keep.add(id);
      const reason=recordingReason(room,context);
      this.observe(id,`${room.platform==='douyin'?'抖音':'B站'}直播间 ${room.roomId}：${reason}${room.chatError?`；弹幕：${safeLog(room.chatError)}`:''}`,room.error?'警告':'信息');
    }
    for(const key of this.observed.keys())if(key.startsWith('room:')&&!keep.has(key))this.observed.delete(key);
  }
  tick(){
    if(this.closed)return this.pending;
    return this.enqueue(async()=>{await this.rotate(logDay(this.now()));await this.flushRepeats();await this.writeState(false);});
  }
  close(message='后台正常退出；全部操作已结束'){
    return this.closePromise??=(async()=>{
      await this.pending;
      await this.record('退出',message,{important:true});this.closed=true;
      await this.enqueue(async()=>{await this.flushRepeats();await this.summary('本次关闭汇总');await this.writeState(true);});
    })();
  }
  // Decode chunks incrementally, cap partial lines, and retain warnings/errors only.
  attach(stream,component){
    if(!stream?.on)return;
    const decoder=new StringDecoder('utf8');let line='';
    const emit=()=>{if(/\b(?:warn|error|fatal|exception|WRN|ERR|FTL)\b|失败|异常|错误/i.test(line))this.record(component,line,{level:'警告'});line='';};
    const consume=text=>{const fragments=text.split('\n');for(let n=0;n<fragments.length;n++){line+=fragments[n].slice(0,Math.max(0,4096-line.length));if(n<fragments.length-1)emit();}};
    stream.on('data',chunk=>consume(decoder.write(chunk)));stream.on('end',()=>{consume(decoder.end());emit();});
  }
}
