import {DOUYIN_USER_AGENT} from './douyin-room.js';
import {parsePlatformJson} from './linkmic-sei.js';

export function numericRoomId(value){
  const input=String(value??'').trim();if(!/^\d+$/.test(input))return null;
  if(input.length>20||BigInt(input)===0n)throw new Error('请输入有效的直播间号。');
  return BigInt(input).toString();
}

export class BilibiliRoomResolver {
  constructor({request=fetch,credentials}={}){this.request=request;this.credentials=credentials;}
  query(route,signal){
    return this.requestJson('https://api.live.bilibili.com/'+route,signal,this.credentials?.get('bilibili'));
  }
  async requestJson(url,signal,cookie){
    const response=await this.request(url,{signal,redirect:'error',headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:'https://live.bilibili.com/',...(cookie?{Cookie:cookie}:{})}});
    if(!response.ok){await response.body?.cancel();throw new Error('B 站暂时无法查询，请稍后重试。');}
    const chunks=[];let size=0;
    for await(const chunk of response.body||[]){size+=chunk.length;if(size>1024*1024){await response.body?.cancel().catch(()=>{});throw new Error('B 站返回的房间信息过大。');}chunks.push(chunk);}
    try{return parsePlatformJson(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('B 站暂时未返回房间信息。');}
  }
  async verifyCookie({cookie=this.credentials?.get('bilibili'),signal=AbortSignal.timeout(8000)}={}){
    const result=await this.requestJson('https://api.bilibili.com/x/web-interface/nav',signal,cookie);
    if(result?.code===-101&&result.data?.isLogin===false)return false;
    if(result?.code===0&&result.data?.isLogin===true)return true;
    throw new Error('B 站暂时无法确认登录状态。');
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

export async function discoverRoomNumber(id, platforms, {signal=AbortSignal.timeout(10000)}={}) {
  const lookups = [...platforms];
  const results = await Promise.allSettled(lookups.map(async platform => platform.lookupRoom(id, signal)));
  const candidates = [], unavailable = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index], platform = lookups[index].id;
    if (result.status === 'rejected') {
      if (result.reason?.code !== 'ROOM_NOT_FOUND') unavailable.push(platform);
      continue;
    }
    const room = result.value;
    if (!room) continue;
    const { roomNumber, url } = room;
    candidates.push({
      platform, roomNumber,
      name: String(room.name || `直播间 ${roomNumber}`).slice(0, 100),
      title: String(room.title || '').slice(0, 300),
      streaming: !!room.streaming,
      url,
    });
  }
  return { candidates, unavailable };
}
