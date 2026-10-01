import {parentPort} from 'node:worker_threads';
import {randomInt} from 'node:crypto';
import {ChatIntake} from './chat-intake.js';
import {LotteryActivities} from './lottery-activities.js';
import {decodePushFrame,decodeChat,decodeLottery,acknowledgeFrame,heartbeatFrame,isLotteryMethod} from './douyin-protocol.js';
import {openDouyinSocket} from './douyin-websocket.js';
import {signChatUrl} from './douyin-signing.js';
import {DOUYIN_USER_AGENT} from './douyin-room.js';

const rooms=new Map(),activities=new LotteryActivities();
const intake=new ChatIntake({filterLottery:(key,message)=>activities.matches(key,message)});
let sequence=0;
const post=message=>parentPort.postMessage(message);
function chatSocketUrl({roomId,userUniqueId},now=Date.now()) {
  const query=new URLSearchParams({app_name:'douyin_web',version_code:'180800',webcast_sdk_version:'1.0.14-beta.0',update_version_code:'1.0.14-beta.0',
    compress:'gzip',device_platform:'web',cookie_enabled:'true',screen_width:'1920',screen_height:'1080',browser_language:'zh-CN',browser_platform:'Win32',
    browser_name:'Mozilla',browser_version:DOUYIN_USER_AGENT.slice('Mozilla/'.length),browser_online:'true',tz_name:'Asia/Shanghai',
    cursor:`d-1_u-1_fh-${userUniqueId}_t-${now}_r-1`,
    internal_ext:`internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${userUniqueId}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:${now}${randomInt(100000,1000000)}`,
    host:'https://live.douyin.com',aid:'6383',live_id:'1',did_rule:'3',endpoint:'live_pc',support_wrds:'1',user_unique_id:userUniqueId,
    im_path:'/webcast/im/fetch/',identity:'audience',need_persist_msg_count:'15',room_id:roomId,heartbeatDuration:'0'});
  const url='wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?'+query;
  return url+'&signature='+encodeURIComponent(signChatUrl(url));
}
function flush(room) {
  if(room.batch)return;
  const batch=intake.take(room.key,{force:room.stopped});
  if(batch){room.batch={...batch,id:++sequence};post({type:'batch',key:room.key,id:room.batch.id,messages:batch.messages,density:batch.density});}
  else if(room.stopped){intake.drop(room.key);activities.drop(room.key);rooms.delete(room.key);post({type:'stopped',key:room.key});}
}
function retry(room,error) {
  if(room.stopped||room.retry)return;
  clearInterval(room.heartbeat);room.socket=null;
  post({type:'status',key:room.key,status:'retry',reason:error?.message==='弹幕握手校验失败。'?'handshake':/^弹幕连接(?:失败|被关闭)：\d+$/.test(error?.message||'')?error.message:'connection'});
  room.retry=setTimeout(()=>{room.retry=null;void connect(room);},Math.min(30000,3000*2**Math.min(room.failures++,4)));
}
async function connect(room) {
  try{
    const socket=await openDouyinSocket(chatSocketUrl(room),{signal:room.abort.signal,
      headers:{'User-Agent':DOUYIN_USER_AGENT,Origin:'https://live.douyin.com',Cookie:room.cookie},
      onClose:error=>retry(room,error),onMessage:bytes=>{
        room.lastFrame=Date.now();const frame=decodePushFrame(bytes);
        if(frame.needAck){const ack=acknowledgeFrame(frame.logId,frame.internalExt);if(room.socket)room.socket.send(ack);else room.firstAck=ack;}
        // Activity messages have priority even when chats precede them in the packet.
        for(const message of frame.messages)if(isLotteryMethod(message.method))for(const activity of decodeLottery(message,{roomId:room.roomId,serverTime:frame.serverTime}))activities.update(room.key,activity);
        for(const message of frame.messages){try{const chat=decodeChat(message,{roomId:room.roomId,sourceStart:room.sourceStart});if(chat)intake.add(room.key,chat);}catch{/* Skip one malformed chat, preserving other messages and the ACK. */}}
      }});
    if(room.stopped){socket.close();return;}
    room.socket=socket;if(room.firstAck){socket.send(room.firstAck);room.firstAck=null;}socket.send(heartbeatFrame());room.failures=0;room.lastFrame=Date.now();post({type:'status',key:room.key,status:'connected'});
    room.heartbeat=setInterval(()=>{if(Date.now()-room.lastFrame>45000)socket.close();else socket.send(heartbeatFrame());},5000);
  }catch(error){retry(room,error);}
}
parentPort.on('message',message=>{
  if(message.type==='configure'){
    intake.setRateLimit(message.rateLimit);
  }else if(message.type==='start'){
    if(rooms.has(message.key)||rooms.size>=64)return;
    const room={...message,key:String(message.key),abort:new AbortController(),failures:0,stopped:false};
    rooms.set(room.key,room);intake.start(room.key,{start:room.sourceStart});void connect(room);
  }else if(message.type==='credentials'){
    const room=rooms.get(message.key);if(room&&!room.stopped){room.cookie=message.cookie;room.userUniqueId=message.userUniqueId;}
  }else if(message.type==='ack'){
    const room=rooms.get(message.key);if(room?.batch?.id===message.id){room.batch.release();room.batch=null;flush(room);}
  }else if(message.type==='stop'){
    const room=rooms.get(message.key);if(!room){post({type:'stopped',key:message.key});return;}
    room.stopped=true;clearTimeout(room.retry);clearInterval(room.heartbeat);room.abort.abort();room.socket?.close();intake.stop(room.key);flush(room);
  }
});
setInterval(()=>{for(const room of rooms.values())flush(room);},200);
setInterval(()=>post({type:'heartbeat'}),2000);
