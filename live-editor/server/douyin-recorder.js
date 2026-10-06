import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DouyinResolver,DOUYIN_USER_AGENT,safeStreamUrl,safeStreamRedirect} from './douyin-room.js';
import {DouyinFlv} from './douyin-flv.js';
import {DouyinChat} from './douyin-chat.js';
import {chatRate} from './chat-rules.js';

export const xmlText=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export async function writeAll(file,bytes){bytes=Buffer.from(bytes);let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);if(!result.bytesWritten)throw new Error('录像写入失败。');offset+=result.bytesWritten;}}
export function chatXml(batch){
  return batch.messages.map(message=>`<d p="${message.time.toFixed(3)},1,25,${xmlText(message.color)},0,0,0,0" user="${xmlText(message.user)}" uid="${xmlText(message.id)}">${xmlText(message.text)}</d>\n`).join('')+
    batch.density.map(bucket=>`<density ts="${bucket.second}" count="${bucket.count}" kept="${bucket.kept}"/>\n`).join('');
}

export class DouyinRecorder {
  constructor(store,{resolver=new DouyinResolver(),request=fetch,chat=new DouyinChat(),now=Date.now,pollMs=5000,idleMs=20000}={}) {
    Object.assign(this,{store,resolver,request,chat,now,pollMs,idleMs});this.entries=new Map();this.started=false;this.closed=false;this.paused=false;this.shutdown=new AbortController();
    this.chat.setRateLimit?.(chatRate(store));
    const savedRooms=store.setting('douyin-rooms');
    for(const saved of Array.isArray(savedRooms)?savedRooms:[])if(saved&&typeof saved.webRid==='string'&&/^\d{1,20}$/.test(saved.webRid)&&this.entries.size<64)this.entries.set(saved.webRid,this.entry(saved));
  }
  entry(saved){return {webRid:saved.webRid,name:String(saved.name||'抖音直播间').slice(0,100),title:String(saved.title||'').slice(0,300),autoRecord:saved.autoRecord!==false,enabled:saved.enabled!==false,streaming:false,recording:false,error:'',chatError:'',nextPoll:0,retryAt:0};}
  get rooms(){return [...this.entries.values()].map(room=>({platform:'douyin',roomId:'douyin:'+room.webRid,webRid:room.webRid,name:room.name,title:room.title,streaming:room.streaming,recording:room.recording,recordingEnabled:room.enabled,autoRecord:room.autoRecord,autoRecordForThisSession:room.enabled,error:room.error,chatError:room.chatError}));}
  save(){this.store.setting('douyin-rooms',[...this.entries.values()].map(room=>({webRid:room.webRid,name:room.name,title:room.title,autoRecord:room.autoRecord,enabled:room.enabled})));}
  start(){
    if(this.closed||this.started)return;this.started=true;
    // Only recover our namespace. Bilibili's independent writer is untouched.
    for(const session of this.store.all("SELECT id FROM sessions WHERE room=0 AND status IN ('recording','waiting')"))if(this.store.setting('douyin-session:'+session.id)){
      this.store.run('UPDATE sources SET closed=1 WHERE session=? AND closed=0',session.id);this.store.run("UPDATE sessions SET status='finishing' WHERE id=?",session.id);
    }
    this.schedule();void this.poll().catch(error=>this.reportPollError(error));
  }
  reportPollError(error){if(!this.closed)this.store.diagnostics?.record('抖音监控循环',error,{level:'错误'});}
  schedule(){if(this.closed||this.paused||!this.started||this.timer)return;this.timer=setTimeout(async()=>{this.timer=null;try{await this.poll();}catch(error){this.reportPollError(error);}finally{this.schedule();}},this.pollMs);}
  assertOpen(){if(this.closed)throw new Error('录制服务已关闭。');}
  room(key){const room=this.entries.get(String(key).replace(/^douyin:/,''));if(!room)throw new Error('直播间不存在。');return room;}
  async add(descriptor,autoRecord=true){
    this.assertOpen();const existing=this.entries.get(descriptor.webRid);if(existing)return this.rooms.find(room=>room.webRid===descriptor.webRid);
    if(this.entries.size>=64)throw new Error('抖音监控房间已达上限。');
    const metadata=await this.resolver.room(descriptor.webRid,{signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(15000)])});this.assertOpen();
    // Another concurrent request may have added this same room.
    if(!this.entries.has(descriptor.webRid)){if(this.entries.size>=64)throw new Error('抖音监控房间已达上限。');const room=this.entry({...metadata,autoRecord,enabled:autoRecord});room.metadata=metadata;room.streaming=metadata.streaming;room.nextPoll=this.now()+15000;this.entries.set(room.webRid,room);this.save();this.maybeRecord(room);}
    return this.rooms.find(room=>room.webRid===descriptor.webRid);
  }
  poll(force=false){
    if(this.closed||this.paused||!this.started)return Promise.resolve();if(this.polling)return this.polling;
    this.polling=(async()=>{
      const rooms=[...this.entries.values()].filter(room=>force||this.now()>=room.nextPoll);let cursor=0;
      const scan=async()=>{while(cursor<rooms.length&&!this.closed&&!this.paused){const room=rooms[cursor++];
        try{
          const metadata=await this.resolver.room(room.webRid,{signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(15000)])});
          if(this.closed||!this.entries.has(room.webRid))continue;
          room.metadata=metadata;room.name=metadata.name;room.title=metadata.title;room.streaming=metadata.streaming;if(!room.blocked)room.error='';
          if(room.sourceId)this.chat.update?.(room.sourceId,{cookie:metadata.cookie,userUniqueId:metadata.userUniqueId});
          room.nextPoll=this.now()+(metadata.streaming?15000:30000);
          if(!metadata.streaming||room.actualRoom&&room.actualRoom!==metadata.roomId){await this.finish(room);}
          this.maybeRecord(room);
        }catch(error){if(!this.closed){this.store.diagnostics?.record(`抖音开播检查 ${room.webRid}`,error,{level:'警告'});room.error='抖音连接失败，正在重试。';room.nextPoll=this.now()+15000;}}
      }};
      await Promise.all([scan(),scan()]);if(!this.closed)this.save();
    })().finally(()=>{this.polling=null;});return this.polling;
  }
  maybeRecord(room){
    if(this.closed||this.paused||!this.started||room.active||room.blocked||!room.enabled||!room.streaming||this.now()<room.retryAt)return;
    if(!room.metadata?.stream){this.store.diagnostics?.record('抖音录制',`房间 ${room.webRid}：未提供 H.264/AAC 画质，未开始录制`,{level:'警告'});room.error='该直播暂未提供可剪辑的 H.264/AAC 画质。';return;}
    room.active=this.capture(room).catch(error=>{this.store.diagnostics?.record('抖音录制',error,{level:'错误'});if(!this.closed)room.error='录像写入失败，请检查磁盘后重试。';room.blocked=true;}).finally(()=>{room.active=null;room.recording=false;room.nextPoll=0;});
  }
  async capture(room){
    const metadata=room.metadata,abort=new AbortController();room.abort=abort;let response,flv,xml,source,session,normalizer;
    let lastData=this.now(),recordError;
    const watchdog=setInterval(()=>{if(this.now()-lastData>this.idleMs&&!abort.signal.aborted){this.store.diagnostics?.record('抖音连接',`房间 ${room.webRid}：连续 ${this.idleMs/1000} 秒没有视频数据，取消连接并重试`,{level:'警告'});abort.abort(new Error('直播连接超时。'));}},Math.min(5000,this.idleMs));
    const signal=AbortSignal.any([this.shutdown.signal,abort.signal]);
    try{
      const origin=safeStreamUrl(metadata.stream.url);if(!origin)throw new Error('直播服务器地址无效。');
      let url=origin;
      for(let attempt=0;attempt<6;attempt++){
        const deadline=setTimeout(()=>abort.abort(new Error('直播连接超时。')),15000);
        try{response=await this.request(url,{signal,redirect:'manual',headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:'https://live.douyin.com/'}});}finally{clearTimeout(deadline);}
        const next=response.headers.get('location');if(!next||![301,302,303,307,308].includes(response.status))break;
        await response.body?.cancel();response=null;
        url=safeStreamRedirect(new URL(next,url).href,origin);if(!url)throw new Error('直播服务器跳转地址无效。');
      }
      if(!response?.ok||!response.body)throw new Error(`直播暂时无法连接（HTTP ${response?.status??'未收到响应'}）。`);
      if(signal.aborted)throw signal.reason;
      const wall=new Date(this.now()).toISOString(),directory=path.join(this.store.root,'originals','douyin',room.webRid);
      await fs.mkdir(directory,{recursive:true});const file=path.join(directory,wall.replace(/[^\d]/g,'')+'-'+randomUUID()+'.flv');
      flv=await fs.open(file,'wx');
      session=room.session&&this.store.session(room.session);
      if(!session){session=this.store.createSession({room:0,title:metadata.title||metadata.name,created:wall});room.session=session.id;this.store.setting('douyin-session:'+session.id,{platform:'douyin',webRid:room.webRid,roomId:metadata.roomId});}
      room.actualRoom=metadata.roomId;
      const start=Math.max(0,session.duration,(Date.parse(wall)-Date.parse(session.created))/1000);
      source=this.store.addSource(session.id,file,start,wall);this.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',source.id);
      room.sourceId=source.id;
      xml=await fs.open(source.xml,'wx');
      await writeAll(xml,`<?xml version="1.0" encoding="utf-8"?>\n<i><CaibaoRecordInfo platform="douyin" roomid="${metadata.roomId}" web_rid="${room.webRid}" start_time="${wall}" title="${xmlText(metadata.title)}"/>\n`);
      this.store.run("UPDATE sessions SET status='recording',error='' WHERE id=?",session.id);room.recording=true;this.store.diagnostics?.record('抖音录制',`房间 ${room.webRid}：开始写入录像；素材 ${source.id}`);
      normalizer=new DouyinFlv();
      try{this.chat.start(source.id,{roomId:metadata.roomId,userUniqueId:metadata.userUniqueId,cookie:metadata.cookie,sourceStart:Date.parse(wall)},
        {write:batch=>writeAll(xml,chatXml(batch)),status:status=>{room.chatError=status==='connected'?'':status==='write-failed'?'弹幕保存失败。':'弹幕连接重试中。';}});}catch{room.chatError='弹幕暂时无法连接。';}
      for await(const chunk of response.body){lastData=this.now();if(signal.aborted)break;for(const bytes of normalizer.feed(chunk))await writeAll(flv,bytes);}
      if(!signal.aborted)normalizer.finish();
    }catch(error){
      if(!this.closed&&(!room.abort?.signal.aborted||room.abort.signal.reason?.message==='直播连接超时。'))this.store.diagnostics?.record('抖音录制连接',error,{level:'警告'});
      // Network failures retain the partial source and reconnect. Invalid
      // codec/data or disk failures stop retries until the user starts again.
      if(!signal.aborted&&source&&(!response?.body||!/fetch|network|terminated|socket|abort/i.test(error.message))){recordError=error;room.blocked=true;room.error=error.message;}
      else if(!this.closed&&!abort.signal.aborted)room.error='直播连接中断，正在重试。';
    }finally{
      clearInterval(watchdog);if(!signal.aborted)abort.abort();
      try{await response?.body?.cancel();}catch{}
      if(source){
        await this.chat.stop(source.id);
        try{if(xml){await writeAll(xml,'</i>\n');await xml.sync();}await flv.sync();
          if((await flv.stat()).size<13)recordError??=new Error('本次录制未收到完整画面。');
        }catch(error){recordError??=error;room.blocked=true;room.error='录像保存失败，请检查磁盘。';}
      }
      await Promise.allSettled([xml?.close(),flv?.close()]);
      if(source){
        this.store.diagnostics?.record('抖音录制',`房间 ${room.webRid}：结束当前文件；${recordError?'文件错误：'+recordError.message:!room.enabled?'用户停止':this.closed?'应用退出':'直播结束或连接中断，将按监控设置继续'}`,{level:recordError?'错误':'信息'});
        // An unsupported/empty/failed source has no index work left to wait for.
        // Preserve its originals and expose the error; it remains deletable.
        this.store.run('UPDATE sources SET closed=MAX(closed,?),error=? WHERE id=?',recordError?2:1,recordError?.message||'',source.id);
        this.store.run("UPDATE sessions SET status=?,error=? WHERE id=?",recordError?'finishing':room.enabled&&!this.closed?'waiting':'finishing',recordError?.message||'',session.id);
      }
      room.recording=false;room.abort=null;room.sourceId=null;room.retryAt=this.now()+3000;
    }
  }
  async startRoom(key){this.assertOpen();const room=this.room(key);room.enabled=true;room.blocked=false;room.error='';room.retryAt=0;room.nextPoll=0;this.save();await this.poll();this.maybeRecord(room);}
  async setAuto(key,enabled){this.assertOpen();const room=this.room(key);room.autoRecord=!!enabled;if(enabled){room.enabled=true;room.blocked=false;room.retryAt=0;room.nextPoll=0;}else if(!room.active){room.enabled=false;await this.finish(room);}this.save();await this.poll();}
  async finish(room){
    room.abort?.abort();await room.active;
    if(room.session){this.store.run("UPDATE sessions SET status='finishing' WHERE id=? AND status IN ('recording','waiting')",room.session);room.session=null;room.actualRoom=null;}
    if(!room.autoRecord)room.enabled=false;
  }
  async stopRoom(key){this.assertOpen();const room=this.room(key);room.enabled=false;this.save();await this.finish(room);}
  async removeRoom(key,confirmed){if(confirmed!==true)throw new Error('请先确认是否移除这个监控房间。');await this.stopRoom(key);this.entries.delete(this.room(key).webRid);this.save();}
  async stopForExit(){this.paused=true;clearTimeout(this.timer);await Promise.all([...this.entries.values()].map(room=>this.finish(room)));}
  async pauseIdle(){if([...this.entries.values()].some(room=>room.active||room.recording))return false;this.paused=true;clearTimeout(this.timer);await this.polling;return ![...this.entries.values()].some(room=>room.active||room.recording);}
  resume(){if(this.closed)return;this.paused=false;this.schedule();}
  close(){return this.closing??=(async()=>{this.closed=true;this.paused=true;clearTimeout(this.timer);this.shutdown.abort();await this.polling;await Promise.all([...this.entries.values()].map(room=>this.finish(room)));await this.chat.close();})();}
}
