import {DouyinResolver,DOUYIN_USER_AGENT,readBoundedResponse,resolveDouyinLink} from './douyin-room.js';
import {signRoomQuery} from './douyin-signing.js';
import {parsePlatformJson} from './linkmic-sei.js';

export function decimal(value){return typeof value==='number'?Number.isSafeInteger(value)&&value>0?String(value):'':typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)?value:'';}
export function selectUserRoom(body,uid){
  if(body?.status_code!==0||!Array.isArray(body.data)||!decimal(uid))return {state:'unknown',reason:'状态接口未返回有效结果'};
  const entries=body.data.flatMap(scene=>Array.isArray(scene.user_live)?scene.user_live:[]).filter(user=>decimal(user.user_id_str??user.user_id)===uid);
  if(!entries.length)return {state:'unknown',reason:'状态接口未返回目标用户'};
  const live=entries.filter(user=>[1,2,5,7].includes(user.live_status)),rooms=[...new Set(live.map(user=>decimal(user.room_id_str??user.room_id)))];
  if(live.length&&rooms.length===1&&rooms[0])return {state:'candidate',roomId:rooms[0]};
  if(entries.every(user=>user.live_status===0))return {state:'offline-observation'};
  return {state:'unknown',reason:'当前连麦状态尚不能确认'};
}
export function isDouyinMonitorLink(input){
  try{return ['www.douyin.com','douyin.com','v.douyin.com','www.iesdouyin.com','live.douyin.com','m.douyin.com','webcast.amemv.com'].includes(new URL(String(input).match(/https?:\/\/[^\s<>]+/)?.[0]).hostname);}catch{return false;}
}
export async function resolveMonitorInput(input,{request=fetch,signal,allowRoom=true}={}){
  const text=String(input??'');if(text.length>4096)throw Error('分享内容过长。');
  let url;try{url=new URL(text.match(/https:\/\/[^\s<>]+/)?.[0]?.replace(/[，。；！）】]+$/u,''));}catch{throw Error('请粘贴抖音个人主页或个人分享链接。');}
  for(let hop=0;hop<6;hop++){
    if(url.protocol!=='https:'||url.port||url.username||url.password||!isDouyinMonitorLink(url.href))throw Error('请使用抖音直播间或个人名片分享链接。');
    // Mobile profile cards resolve to this official share page. Its path names
    // the target; tracking parameters can contain other users and are ignored.
    const uid=(['www.douyin.com','douyin.com'].includes(url.hostname)?/^\/user\/([A-Za-z0-9_.-]{8,160})\/?$/
      :url.hostname==='www.iesdouyin.com'?/^\/share\/user\/([A-Za-z0-9_.-]{8,160})\/?$/:null)?.exec(url.pathname)?.[1];
    if(uid){
      const hints=url.searchParams.getAll('sec_uid');
      if(hints.length>1||hints.length===1&&hints[0]!==uid)throw Error('名片链接中的用户信息不一致，请重新复制分享内容。');
      return {kind:'profile',secUid:uid};
    }
    if(allowRoom&&url.hostname!=='v.douyin.com'&&url.hostname!=='www.iesdouyin.com')return {kind:'room',...await resolveDouyinLink(url.href,{request,signal})};
    if(url.hostname!=='v.douyin.com')throw Error('这是直播间或作品链接，请改用用户的个人主页。');
    const response=await request(url,{signal,redirect:'manual',headers:{'User-Agent':DOUYIN_USER_AGENT}}),next=response.headers.get('location');
    await response.body?.cancel();
    if(!next||![301,302,303,307,308].includes(response.status))throw Error('个人分享链接暂时无法展开，请重新复制名片分享内容后重试。');
    url=new URL(next,url);
  }
  throw Error('个人分享链接跳转过多。');
}
export async function profileSecUid(input,options={}){return (await resolveMonitorInput(input,{...options,allowRoom:false})).secUid;}
export class DouyinUserDiscovery{
  constructor({resolver=new DouyinResolver(),request=fetch}={}){Object.assign(this,{resolver,request});}
  async json(endpoint,params,signal){
    signal?.throwIfAborted();const visitor=await this.resolver.cookie(signal);signal?.throwIfAborted();
    const query=new URLSearchParams(params);query.set('a_bogus',signRoomQuery(query.toString(),DOUYIN_USER_AGENT));
    const response=await this.request(endpoint+'?'+query,{redirect:'error',signal,headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:new URL(endpoint).origin+'/',Cookie:visitor.cookie}});
    return parsePlatformJson(await readBoundedResponse(response,2*1024*1024));
  }
  async identity(input,{signal}={}){
    const secUid=await profileSecUid(input,{request:this.request,signal});
    return this.profileIdentity(secUid,{signal});
  }
  async monitorIdentity(input,{signal}={}){
    const resolved=await resolveMonitorInput(input,{request:this.request,signal});
    if(resolved.kind==='profile')return this.profileIdentity(resolved.secUid,{signal});
    const metadata=await this.resolver.room(resolved.webRid,{signal});
    return this.roomIdentity(metadata);
  }
  roomIdentity(metadata){
    const uid=decimal(metadata?.ownerId),ownWebRid=decimal(metadata?.webRid);
    if(!uid||!ownWebRid)throw Error('暂时无法核验直播间主播的身份，请稍后重试。');
    return {uid,name:String(metadata.name||'抖音主播').slice(0,100),secUid:'',profile:'',ownWebRid};
  }
  async profileIdentity(secUid,{signal}={}){
    const body=await this.json('https://www.douyin.com/aweme/v1/web/user/profile/other/',{device_platform:'webapp',aid:'6383',channel:'channel_pc_web',publish_video_strategy_type:'2',source:'channel_pc_web',sec_user_id:secUid,personal_center_strategy:'1',profile_other_record_enable:'1',land_to:'1'},signal);
    const user=body?.user,uid=decimal(user?.uid);
    if(body?.status_code!==0||!uid||user.sec_uid!==secUid)throw Error('暂时无法核验这个用户的身份，请稍后重试。');
    return {uid,secUid,name:String(user.nickname||'抖音用户').slice(0,100),profile:'https://www.douyin.com/user/'+secUid};
  }
  async observe(uid,{signal,ownWebRid}={}){
    if(decimal(ownWebRid)){
      try{
        const metadata=await this.resolver.room(ownWebRid,{signal});
        if(metadata.ownerId===uid&&metadata.streaming&&metadata.stream)return {state:'self-live',metadata};
      }catch(error){signal?.throwIfAborted();}
    }
    const body=await this.json('https://live.douyin.com/webcast/distribution/check_user_live_status/',{user_ids:uid,aid:'6383',distribution_scenes:'254',channel:'channel_pc_web',device_platform:'webapp'},signal);
    const candidate=selectUserRoom(body,uid);if(candidate.state!=='candidate')return candidate;
    const link=await resolveDouyinLink('https://webcast.amemv.com/douyin/webcast/reflow/'+candidate.roomId,{request:this.request,signal});
    const metadata=await this.resolver.room(link.webRid,{signal});
    if(metadata.roomId!==candidate.roomId)return {state:'unknown',reason:'直播间已发生变化，等待重新核验'};
    if(!metadata.streaming||!metadata.stream)return {state:'unknown',reason:'主直播间暂未提供可录制画面'};
    if(metadata.ownerId===uid)return {state:'self-live',metadata};
    const people=await this.resolver.linkmic({roomId:metadata.roomId,anchorId:metadata.ownerId,channel:metadata.roomId,version:15,signal});
    if(!people.some(person=>person.id===uid))return {state:'unknown',reason:'未在当前连麦名单中核验到目标，等待确认'};
    return {state:'guest-confirmed',metadata};
  }
}
