import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DouyinResolver,DOUYIN_USER_AGENT,safeStreamUrl,safeStreamRedirect} from './douyin-room.js';
import {DouyinFlv,DouyinStreamChange} from './douyin-flv.js';
import {DouyinChat} from './douyin-chat.js';
import {chatStatusMessage} from './douyin-chat-status.js';
import {chatRate} from './chat-rules.js';

export const xmlText=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export async function writeAll(file,bytes){bytes=Buffer.from(bytes);let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset);if(!result.bytesWritten)throw new Error('录像写入失败。');offset+=result.bytesWritten;}}
export function chatXml(batch){
  return batch.messages.map(message=>`<d platform="douyin" p="${message.time.toFixed(3)},1,25,${xmlText(message.color)},0,0,0,0" user="${xmlText(message.user)}" uid="${xmlText(message.id)}"${message.senderId?` sender_id="${xmlText(message.senderId)}"`:''}>${xmlText(message.text)}</d>\n`).join('')+
    batch.density.map(bucket=>`<density ts="${bucket.second}" count="${bucket.count}" kept="${bucket.kept}"/>\n`).join('')+
    (batch.gifts||[]).map(g=>`<gift platform="douyin" eventid="${xmlText(g.id)}" ts="${g.time.toFixed(3)}" user="${xmlText(g.user)}" giftid="${xmlText(g.giftId)}" giftname="${xmlText(g.name)}" giftcount="${g.count}"${g.totalPrice===null?'':` total_price="${g.totalPrice}"`} icon="${xmlText(g.icon)}"/>\n`).join('');
}

export class DouyinRecorder {
  constructor(store,{credentials,resolver=new DouyinResolver({credentials}),request=fetch,chat=new DouyinChat(),now=Date.now,pollMs=5000,idleMs=20000,mediaIdleMs=10000,watchdogMs=1000}={}) {
    for(const value of [pollMs,idleMs,mediaIdleMs,watchdogMs])if(!Number.isSafeInteger(value)||value<1)throw new Error('录制监测间隔无效。');
    Object.assign(this,{store,resolver,request,chat,now,pollMs,idleMs,mediaIdleMs,watchdogMs});this.entries=new Map();this.started=false;this.closed=false;this.paused=false;this.shutdown=new AbortController();
    this.chat.setRateLimit?.(chatRate(store));
    const savedRooms=store.setting('douyin-rooms');
    for(const saved of Array.isArray(savedRooms)?savedRooms:[])if(saved&&typeof saved.webRid==='string'&&/^\d{1,20}$/.test(saved.webRid)&&this.entries.size<64)this.entries.set(saved.webRid,this.entry(saved));
  }
  entry(saved){return {webRid:saved.webRid,name:String(saved.name||'抖音直播间').slice(0,100),title:String(saved.title||'').slice(0,300),autoRecord:saved.autoRecord!==false,enabled:saved.enabled!==false,followers:new Map(),streaming:false,recording:false,error:'',chatError:'',nextPoll:0,retryAt:0,recoveryFailures:0,recoveryReason:''};}
  wanted(room){return room.enabled||[...room.followers.values()].some(roomId=>roomId===room.metadata?.roomId);}
  get rooms(){return [...this.entries.values()].map(room=>({platform:'douyin',roomId:'douyin:'+room.webRid,webRid:room.webRid,name:room.name,title:room.title,followOnly:room.followOnly===true,streaming:room.streaming,recording:room.recording,recordingEnabled:this.wanted(room),followUsers:room.followers.size,autoRecord:room.autoRecord,autoRecordForThisSession:this.wanted(room),error:room.error,chatError:room.chatError,chatStatus:room.sourceId?(this.chat.snapshot?.(room.sourceId)??null):null,recordingHealth:room.recoveryReason?{state:'recovering',message:room.recoveryReason}:null,recordingProgress:room.progress?{...room.progress}:null}));}
  async applyCredentials(){
    // Reauthenticate chat only; never interrupt the video writer on a login edit.
    if(!this.entries.size)return;
    let details;
    try{details=await this.resolver.cookie(AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(15000)]));}
    catch(error){
      for(const room of this.entries.values()){
        if(room.metadata)room.metadata.cookie='';
        if(room.sourceId)this.chat.update?.(room.sourceId,{cookie:'',userUniqueId:room.metadata?.userUniqueId},{reauthenticate:true});
        room.credentialsPending=true;
        room.nextPoll=0;
      }
      throw error;
    }
    for(const room of this.entries.values()){
      if(room.metadata)Object.assign(room.metadata,details);
      if(room.sourceId)this.chat.update?.(room.sourceId,details,{reauthenticate:true});
      room.credentialsPending=false;
      room.nextPoll=0;
    }
  }

  save(){this.store.setting('douyin-rooms',[...this.entries.values()].filter(room=>!room.followOnly).map(room=>({webRid:room.webRid,name:room.name,title:room.title,autoRecord:room.autoRecord,enabled:room.enabled})));}
  async acquireFollow(uid,metadata,isCurrent=()=>true){
    this.assertOpen();let room=this.entries.get(metadata.webRid);
    if(!room){if(this.entries.size>=64)throw Error('抖音监控房间已达上限。');room=this.entry({...metadata,autoRecord:false,enabled:false});room.followOnly=true;this.entries.set(room.webRid,room);}
    if(room.actualRoom&&room.actualRoom!==metadata.roomId)await this.finish(room);
    this.assertOpen();if(!isCurrent())throw Error('跟随任务已变化。');room.metadata=metadata;room.name=metadata.name;room.title=metadata.title;room.streaming=metadata.streaming;room.followers.set(uid,metadata.roomId);room.nextPoll=this.now()+15000;this.maybeRecord(room);
  }
  async releaseFollow(uid,webRid){
    const room=this.entries.get(webRid);if(!room)return;room.followers.delete(uid);
    if(!this.wanted(room))await this.finish(room);
    if(room.followOnly&&!room.followers.size&&!room.enabled&&this.entries.get(webRid)===room)this.entries.delete(webRid);
  }
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
    this.assertOpen();const existing=this.entries.get(descriptor.webRid);if(existing){if(existing.followOnly){existing.followOnly=false;existing.autoRecord=autoRecord;existing.enabled=autoRecord;this.save();this.maybeRecord(existing);}return this.rooms.find(room=>room.webRid===descriptor.webRid);}
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
          if(room.sourceId)this.chat.update?.(room.sourceId,{cookie:metadata.cookie,userUniqueId:metadata.userUniqueId},{reauthenticate:room.credentialsPending===true});
          room.credentialsPending=false;
          room.nextPoll=this.now()+(metadata.streaming?15000:30000);
          await this.onRoomMetadata?.(room,metadata);
          if(!metadata.streaming||room.actualRoom&&room.actualRoom!==metadata.roomId){await this.finish(room);}
          this.maybeRecord(room);
        }catch(error){if(!this.closed){this.store.diagnostics?.record(`抖音开播检查 ${room.webRid}`,error,{level:'警告'});room.error='抖音连接失败，正在重试。';room.nextPoll=this.now()+15000;}}
      }};
      await Promise.all([scan(),scan()]);if(!this.closed)this.save();
    })().finally(()=>{this.polling=null;});return this.polling;
  }
  maybeRecord(room){
    if(this.closed||this.paused||!this.started||room.active||room.blocked||!this.wanted(room)||!room.streaming||this.now()<room.retryAt)return;
    if(!room.metadata?.stream){this.store.diagnostics?.record('抖音录制',`房间 ${room.webRid}：未提供 H.264/AAC 画质，未开始录制`,{level:'警告'});room.error='该直播暂未提供可剪辑的 H.264/AAC 画质。';return;}
    room.active=this.capture(room).catch(error=>{this.store.diagnostics?.record('抖音录制',error,{level:'错误'});if(!this.closed)room.error='录像写入失败，请检查磁盘后重试。';room.blocked=true;}).finally(()=>{room.active=null;room.recording=false;room.nextPoll=0;});
  }
  async capture(room){
    const metadata=room.metadata,abort=new AbortController();room.abort=abort;let response,flv,xml,source,session,normalizer;
    let lastData=this.now(),lastMedia=lastData,lastVideo=lastData,mediaValue=-1,videoValue=null,recordError,recoverable;
    const healthySince=this.now();
    const watchdog=setInterval(()=>{
      if(abort.signal.aborted)return;
      const at=this.now();
      const reason=at-lastData>=this.idleMs?'直播连接长时间未收到数据。'
        :at-lastMedia>=this.mediaIdleMs||normalizer?.videoTime!==null&&normalizer?.videoTime!==undefined&&at-lastVideo>=this.mediaIdleMs?'直播仍收到数据，但有效画面时间未推进。':'';
      if(reason){this.store.diagnostics?.record('抖音录制恢复',`房间 ${room.webRid}：${reason} 保留已录内容并重连。`,{level:'警告'});abort.abort(new DouyinStreamChange(reason));}
    },this.watchdogMs);
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
      if(!session){session=this.store.createSession({room:0,title:metadata.title||metadata.name,created:wall});room.session=session.id;this.store.setting('douyin-session:'+session.id,{platform:'douyin',webRid:room.webRid,roomId:metadata.roomId,hostName:metadata.name});}
      room.actualRoom=metadata.roomId;
      const start=Math.max(0,session.duration,(Date.parse(wall)-Date.parse(session.created))/1000);
      source=this.store.addSource(session.id,file,start,wall);this.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',source.id);
      this.store.setting('linkmic-owner:'+source.id,{id:metadata.ownerId||'',name:metadata.name,roomId:metadata.roomId});
      if(metadata.stream.cameraLayout)this.store.setting('recording-camera:'+source.id,metadata.stream.cameraLayout);
      room.sourceId=source.id;
      xml=await fs.open(source.xml,'wx');
      await writeAll(xml,`<?xml version="1.0" encoding="utf-8"?>\n<i><CaibaoRecordInfo platform="douyin" roomid="${metadata.roomId}" web_rid="${room.webRid}" start_time="${wall}" title="${xmlText(metadata.title)}"/>\n`);
      this.store.run("UPDATE sessions SET status='recording',error='' WHERE id=?",session.id);room.recording=true;this.followCaptured?.(room);this.store.diagnostics?.record('抖音录制',`房间 ${room.webRid}：开始写入录像；素材 ${source.id}`);
      normalizer=new DouyinFlv();room.progress={observedAt:this.now(),bytes:0,mediaMs:0,writeLatencyMs:0,inFlightWriteSince:null};
      try{const chatCredentials=this.resolver.cookie?await this.resolver.cookie(signal):room.metadata||metadata;this.chat.start(source.id,{roomId:metadata.roomId,userUniqueId:chatCredentials.userUniqueId,cookie:chatCredentials.cookie,sourceStart:Date.parse(wall)},
        {write:batch=>writeAll(xml,chatXml(batch)),status:(status,detail)=>{
          if(['connected','first-frame','first-comment','first-gift','first-write'].includes(status))room.chatError='';
          else if(status==='write-failed')room.chatError='弹幕保存失败。';
          else if(status==='retry')room.chatError='弹幕连接重试中。';
          const event=chatStatusMessage(room.webRid,status,detail);if(event)this.store.diagnostics?.record('抖音弹幕',event.message,{level:event.level});
        }});}catch{room.chatError='弹幕暂时无法连接。';this.store.diagnostics?.record('抖音弹幕',`房间 ${room.webRid}：弹幕采集未能启动。`,{level:'警告'});}
      for await(const chunk of response.body){
        lastData=this.now();if(signal.aborted)break;
        let frames,change;
        try{frames=normalizer.feed(chunk);}catch(error){if(error.code!=='DOUYIN_STREAM_CHANGE')throw error;frames=error.frames;change=error;}
        const started=this.now();let written=0;
        room.progress.inFlightWriteSince=started;
        for(const bytes of frames){await writeAll(flv,bytes);written+=bytes.length;}
        room.progress.bytes+=written;room.progress.mediaMs=normalizer.duration*1000;
        room.progress.writeLatencyMs=Math.max(0,this.now()-started);room.progress.inFlightWriteSince=null;room.progress.observedAt=this.now();
        if(room.progress.mediaMs>mediaValue){mediaValue=room.progress.mediaMs;lastMedia=this.now();}
        if(normalizer.videoTime!==null&&(videoValue===null||normalizer.videoTime>videoValue)){
          const advanced=videoValue!==null;videoValue=normalizer.videoTime;lastVideo=this.now();
          if(advanced&&room.recoveryReason){room.recoveryReason='';room.error='';this.store.diagnostics?.record('抖音录制恢复',`房间 ${room.webRid}：已重新收到有效画面，继续录制。`);}
        }
        if(this.now()-healthySince>=30000&&this.now()-lastVideo<this.mediaIdleMs&&normalizer.duration>=20)room.recoveryFailures=0;
        if(change)throw change;
      }
      if(signal.aborted&&signal.reason?.code==='DOUYIN_STREAM_CHANGE')throw signal.reason;
      if(!signal.aborted)normalizer.finish();
    }catch(error){
      recoverable=error.code==='DOUYIN_STREAM_CHANGE'?error:signal.reason?.code==='DOUYIN_STREAM_CHANGE'?signal.reason:null;
      if(!this.closed&&(!room.abort?.signal.aborted||room.abort.signal.reason?.message==='直播连接超时。'))this.store.diagnostics?.record('抖音录制连接',error,{level:'警告'});
      // Network failures retain the partial source and reconnect. Invalid
      // codec/data or disk failures stop retries until the user starts again.
      if(!recoverable&&!signal.aborted&&source&&(!response?.body||!/fetch|network|terminated|socket|abort/i.test(error.message))){recordError=error;room.blocked=true;room.error=error.message;}
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
        this.store.run("UPDATE sessions SET status=?,error=? WHERE id=?",recordError?'finishing':this.wanted(room)&&!this.closed?'waiting':'finishing',recordError?.message||'',session.id);
      }
      room.recording=false;room.abort=null;room.sourceId=null;room.progress=null;room.retryAt=this.now()+3000;
      if(recoverable&&!recordError&&!this.closed&&this.wanted(room)){
        const delay=Math.min(30000,1000*2**Math.min(room.recoveryFailures++,5));
        room.retryAt=this.now()+delay;room.nextPoll=room.retryAt;room.recoveryReason=`直播流切换或停滞，正在恢复录制（${delay/1000} 秒后重试）`;
        this.store.diagnostics?.record('抖音录制恢复',`房间 ${room.webRid}：${recoverable.message} ${delay/1000} 秒后重新查询直播地址。`,{level:'警告'});
        clearTimeout(room.recoveryTimer);room.recoveryTimer=setTimeout(()=>{
          room.recoveryTimer=null;
          if(!this.closed&&!this.paused&&this.entries.get(room.webRid)===room&&this.wanted(room)){room.nextPoll=0;void this.poll().catch(error=>this.reportPollError(error));}
        },delay);room.recoveryTimer.unref?.();
      }
    }
  }
  async startRoom(key){this.assertOpen();const room=this.room(key);room.followOnly=false;room.enabled=true;room.blocked=false;room.error='';room.recoveryFailures=0;room.recoveryReason='';clearTimeout(room.recoveryTimer);room.recoveryTimer=null;room.retryAt=0;room.nextPoll=0;this.save();await this.poll();this.maybeRecord(room);}
  async setAuto(key,enabled){this.assertOpen();const room=this.room(key);room.followOnly=false;room.autoRecord=!!enabled;if(enabled){room.enabled=true;room.blocked=false;room.retryAt=0;room.nextPoll=0;}else if(!room.active){room.enabled=false;if(!this.wanted(room))await this.finish(room);}this.save();await this.poll();}
  async finish(room){
    clearTimeout(room.recoveryTimer);room.recoveryTimer=null;room.recoveryReason='';room.recoveryFailures=0;
    room.abort?.abort();await room.active;
    if(room.session){this.store.run("UPDATE sessions SET status='finishing' WHERE id=? AND status IN ('recording','waiting')",room.session);room.session=null;room.actualRoom=null;}
    if(!room.autoRecord)room.enabled=false;
  }
  async stopRoom(key){this.assertOpen();const room=this.room(key);room.enabled=false;this.save();if(!this.wanted(room))await this.finish(room);}
  async removeRoom(key,confirmed){if(confirmed!==true)throw new Error('请先确认是否移除这个监控房间。');await this.stopRoom(key);this.entries.delete(this.room(key).webRid);this.save();}
  async stopForExit(){this.paused=true;clearTimeout(this.timer);await Promise.all([...this.entries.values()].map(room=>this.finish(room)));}
  async pauseIdle(){if([...this.entries.values()].some(room=>room.active||room.recording))return false;this.paused=true;clearTimeout(this.timer);await this.polling;return ![...this.entries.values()].some(room=>room.active||room.recording);}
  resume(){if(this.closed)return;this.paused=false;this.schedule();}
  close(){return this.closing??=(async()=>{this.closed=true;this.paused=true;clearTimeout(this.timer);this.shutdown.abort();await this.polling;await Promise.all([...this.entries.values()].map(room=>this.finish(room)));await this.chat.close();})();}
}
