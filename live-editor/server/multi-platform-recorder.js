import {Recorder} from './recorder.js';
import {DouyinRecorder} from './douyin-recorder.js';
import {isDouyinLink,resolveDouyinLink} from './douyin-room.js';
import {BilibiliRoomResolver,numericRoomId,discoverRoomNumber} from './room-lookup.js';

export class MultiPlatformRecorder extends Recorder {
  constructor(store,options={}){super(store,options);this.douyin=new DouyinRecorder(store,options.douyin);this.bilibiliResolver=options.bilibiliResolver||new BilibiliRoomResolver();}
  get rooms(){return [...(this.biliRooms||[]).map(room=>({...room,platform:'bilibili'})),...(this.douyin?.rooms||[])];}
  set rooms(rooms){this.biliRooms=rooms;}
  get available(){return this.online||this.douyin.started&&!this.douyin.closed;}
  get connectionPending(){return !this.online&&(this.biliRooms.length>0||!this.douyin.rooms.length);}
  start(){this.douyin.start();return super.start();}
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
  async stopForExit(rooms){const results=await Promise.allSettled([super.stopForExit(rooms.filter(room=>room.platform!=='douyin')),this.douyin.stopForExit()]);for(const result of results)if(result.status==='rejected')throw result.reason;}
  async stopIdle(){if(!await this.douyin.pauseIdle())return false;const stopped=await super.stopIdle();if(!stopped)this.douyin.resume();return stopped;}
  close(){super.close();return this.douyin.close();}
}
