import {DOUYIN_USER_AGENT} from './douyin-room.js';

export function numericRoomId(value){
  const input=String(value??'').trim();if(!/^\d+$/.test(input))return null;
  if(input.length>20||BigInt(input)===0n)throw new Error('请输入有效的直播间号。');
  return BigInt(input).toString();
}

export class BilibiliRoomResolver {
  constructor({request=fetch}={}){this.request=request;}
  async query(route,signal){
    const response=await this.request('https://api.live.bilibili.com/'+route,{signal,redirect:'error',headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:'https://live.bilibili.com/'}});
    if(!response.ok){await response.body?.cancel();throw new Error('B 站暂时无法查询，请稍后重试。');}
    const chunks=[];let size=0;
    for await(const chunk of response.body||[]){size+=chunk.length;if(size>1024*1024){await response.body?.cancel().catch(()=>{});throw new Error('B 站返回的房间信息过大。');}chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('B 站暂时未返回房间信息。');}
  }
  async room(id,{signal=AbortSignal.timeout(10000)}={}){
    if(!/^\d{1,20}$/.test(id)||BigInt(id)>2147483647n||BigInt(id)===0n)return null;
    const result=await this.query('room/v1/Room/get_info?room_id='+id,signal);
    if(result.code===1&&/未找到|不存在/.test(result.message))return null;
    const info=result.data;
    if(result.code!==0||!Number.isInteger(info?.room_id)||info.room_id<=0||info.room_id>2147483647||!(info.uid>0))throw new Error('B 站暂时无法查询，请稍后重试。');
    let name='';
    try{const anchor=await this.query('live_user/v1/UserInfo/get_anchor_in_room?roomid='+info.room_id,signal);if(anchor.code===0&&typeof anchor.data?.info?.uname==='string')name=anchor.data.info.uname;}catch{ /* The confirmed room remains selectable when its nickname lookup fails. */ }
    return {roomId:info.room_id,name:name||`直播间 ${info.room_id}`,title:String(info.title||''),streaming:info.live_status===1};
  }
}

export async function discoverRoomNumber(id,{bilibili,douyin,signal=AbortSignal.timeout(10000)}){
  const results=await Promise.allSettled([bilibili.room(id,{signal}),douyin.room(id,{signal})]);
  const candidates=[],unavailable=[];
  for(let index=0;index<results.length;index++){
    const result=results[index],platform=index===0?'bilibili':'douyin';
    if(result.status==='rejected'){if(result.reason?.code!=='ROOM_NOT_FOUND')unavailable.push(platform);continue;}
    const room=result.value;if(!room)continue;
    const roomNumber=platform==='bilibili'?String(room.roomId):id;
    candidates.push({platform,roomNumber,name:String(room.name||`直播间 ${roomNumber}`).slice(0,100),title:String(room.title||'').slice(0,300),streaming:!!room.streaming,
      url:platform==='bilibili'?'https://live.bilibili.com/'+roomNumber:'https://live.douyin.com/'+roomNumber});
  }
  return {candidates,unavailable};
}
