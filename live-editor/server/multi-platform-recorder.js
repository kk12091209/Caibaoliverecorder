import {Recorder} from './recorder.js';
import {DouyinUserFollow} from './douyin-user-follow.js';
import {DouyinRecorder} from './douyin-recorder.js';
import {isDouyinLink,resolveDouyinLink} from './douyin-room.js';
import {BilibiliRoomResolver,numericRoomId,discoverRoomNumber} from './room-lookup.js';
import {isDouyinMonitorLink,decimal} from './douyin-user-discovery.js';

export class MultiPlatformRecorder extends Recorder {
  constructor(store,options={}){super(store,options);this.douyin=new DouyinRecorder(store,options.douyin);this.following=new DouyinUserFollow(store,{recorder:this.douyin,...options.douyinFollow});this.bilibiliResolver=options.bilibiliResolver||new BilibiliRoomResolver({credentials:options.credentials});this.migrations=new Map();this.douyin.onRoomMetadata=(room,metadata)=>this.adoptMonitoredRoom(room,metadata);}
  get rooms(){return [...(this.biliRooms||[]).map(room=>({...room,platform:'bilibili'})),...(this.douyin?.rooms||[])];}
  set rooms(rooms){this.biliRooms=rooms;}
  get available(){return this.online||this.douyin.started&&!this.douyin.closed;}
  get connectionPending(){return !this.online&&(this.biliRooms.length>0||!this.douyin.rooms.length&&!this.following.targets.size);}
  start(){this.douyin.start();this.following.start();return super.start();}
  get anchors(){
    const targets=this.following.snapshot;
    return [...this.rooms.filter(room=>room.platform!=='douyin'||!room.followOnly&&!targets.some(target=>target.ownWebRid===room.webRid)).map(room=>({...room,key:room.platform==='douyin'?room.roomId:'bilibili:'+room.roomId,enabled:room.recordingEnabled??(room.autoRecord&&room.autoRecordForThisSession!==false),ownWebRid:String(room.webRid||room.roomId),legacy:true,history:[]})),
      ...targets.map(target=>({...target,key:'douyin-user:'+target.uid,platform:'douyin',legacy:false}))];
  }
  materialOrigins(sessions){
    if(!sessions.length)return sessions;
    const bySession=new Map();
    for(const row of this.store.all(`SELECT DISTINCT m.session,i.uid,i.name,i.host,i.kind,i.web_rid FROM douyin_follow_materials m JOIN douyin_follow_intervals i ON i.id=m.interval WHERE m.session IN (${sessions.map(()=>'?').join(',')})`,...sessions.map(s=>s.id))){const list=bySession.get(row.session)||[];list.push(row);bySession.set(row.session,list);}
    return sessions.map(session=>{const monitoring=bySession.get(session.id)||[],origin=this.store.setting('douyin-session:'+session.id);return {...session,monitoring,hostName:origin?.hostName||monitoring[0]?.host||this.biliRooms?.find(room=>Number(room.roomId)===session.room)?.name||'',captureKinds:monitoring.length?[...new Set(monitoring.map(item=>item.kind==='guest'?'guest':'self'))]:session.room>0||origin?['self']:[]};});
  }
  async adoptMonitoredRoom(room,metadata){
    if(room.followOnly||this.closed||this.douyin.closed||!decimal(metadata?.ownerId)||this.douyin.entries.get(room.webRid)!==room)return;
    if(this.migrations.has(room.webRid))return this.migrations.get(room.webRid);
    const task=(async()=>{
      const identity={uid:metadata.ownerId,name:metadata.name,ownWebRid:room.webRid,secUid:'',profile:''};
      const target=this.following.register(identity,{enabled:room.enabled});
      if(room.enabled&&!target.enabled){target.enabled=true;target.state='监控中，等待开播或连麦';this.following.save();}
      // Transfer a running own-room capture to the same UID before removing
      // the old room intent. Other monitored guests keep their references.
      if(target.enabled&&metadata.streaming&&metadata.stream){target.generation++;target.abort?.abort();await this.following.check(target,{state:'self-live',metadata});}
      if(this.douyin.entries.get(room.webRid)!==room)return;
      room.followOnly=true;room.enabled=false;room.autoRecord=false;this.douyin.save();
      await this.douyin.releaseFollow('',room.webRid);
    })().finally(()=>this.migrations.delete(room.webRid));
    this.migrations.set(room.webRid,task);return task;
  }
  async addAnchor(input){
    this.assertOpen();const number=numericRoomId(input.url);
    if(number){
      const {candidates,unavailable}=await discoverRoomNumber(number,{bilibili:this.bilibiliResolver,douyin:this.douyin.resolver,signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(10000)])});this.assertOpen();
      if(!candidates.length)throw Error(unavailable.length?'主播查询失败，请重试或使用分享链接。':'未找到主播，请检查房间号。');
      if(candidates.length>1||unavailable.length)return {needsSelection:true,candidates,unavailable};
      return this.addAnchor({...input,url:candidates[0].url});
    }
    if(isDouyinMonitorLink(input.url)){
      const target=await this.following.addAnchor(input.url),room=this.douyin.entries.get(target.ownWebRid);
      if(room&&!room.followOnly){const metadata=await this.douyin.resolver.room(room.webRid,{signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(15000)])});await this.adoptMonitoredRoom(room,metadata);}
      return this.anchors.find(item=>item.key==='douyin-user:'+target.uid);
    }
    return super.addRoom({...input,autoRecord:true});
  }
  async anchorAction(key,action,input={}){
    if(!['start','stop','remove'].includes(action))throw Error('主播操作无效。');
    if(String(key).startsWith('douyin-user:')){const uid=key.slice(12);if(action==='remove')await this.following.remove(uid,input.confirmed);else await this.following.enable(uid,action==='start');return;}
    if(String(key).startsWith('bilibili:')){const id=key.slice(9);if(action==='start'){await super.setAuto(Number(id),true);await super.poll();}else await this.action(id,action,input);return;}
    if(String(key).startsWith('douyin:')){await this.migrations.get(key.slice(7));const target=[...this.following.targets.values()].find(item=>item.ownWebRid===key.slice(7));if(target)return this.anchorAction('douyin-user:'+target.uid,action,input);return this.action(key,action,input);}
    throw Error('监控主播不存在。');
  }
  async addRoom(input){
    const number=numericRoomId(input.url);
    if(number){
      const {candidates,unavailable}=await discoverRoomNumber(number,{bilibili:this.bilibiliResolver,douyin:this.douyin.resolver,signal:AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(10000)])});this.assertOpen();
      if(!candidates.length)throw new Error(unavailable.length?'房间查询失败，请重试或使用直播链接。':'未找到直播间，请检查房间号。');
      if(candidates.length>1||unavailable.length)return {needsSelection:true,candidates,unavailable};
      return this.addRoom({...input,url:candidates[0].url});
    }
    if(isDouyinLink(input.url))return this.douyin.add(await resolveDouyinLink(input.url),input.autoRecord!==false);
    return super.addRoom(input);
  }
  async action(key,action,input={}){
    if(String(key).startsWith('douyin:')){
      this.douyin.room(key);
      if(action==='stop'||action==='remove'&&input.confirmed===true)await this.following.pauseRoom(String(key).slice(7));
      if(!this.douyin.entries.has(String(key).slice(7))&&['stop','remove'].includes(action))return;
      if(action==='start')await this.douyin.startRoom(key);else if(action==='stop')await this.douyin.stopRoom(key);
      else if(action==='auto')await this.douyin.setAuto(key,input.enabled);else if(action==='remove')await this.douyin.removeRoom(key,input.confirmed);
    }else{
      const id=Number(key);if(action==='stop')await super.stopRoom(id);else if(action==='remove')await super.removeRoom(id,input.confirmed);
      else if(action==='auto')await super.setAuto(id,input.enabled);else await super.startRoom(id);
      await super.poll();
    }
  }
  async roomsForExit(){let rooms;try{rooms=await super.roomsForExit();}catch(error){this.error=error.message;rooms=this.biliRooms;}return [...rooms.filter(room=>room.platform!=='douyin'),...this.douyin.rooms];}
  rememberExitRooms(rooms){super.rememberExitRooms(rooms.filter(room=>room.platform!=='douyin'));}
  async stopForExit(rooms){await this.following.close();const results=await Promise.allSettled([super.stopForExit(rooms.filter(room=>room.platform!=='douyin')),this.douyin.stopForExit()]);for(const result of results)if(result.status==='rejected')throw result.reason;}
  async stopIdle(){if([...this.following.targets.values()].some(target=>target.enabled))return false;if(!await this.douyin.pauseIdle())return false;const stopped=await super.stopIdle();if(!stopped)this.douyin.resume();return stopped;}
  async close(){super.close();await this.following.close();return this.douyin.close();}
}
