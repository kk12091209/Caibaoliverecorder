import {parsePlatformJson} from './linkmic-sei.js';
import {readBoundedResponse} from './douyin-room.js';

export const XHS_USER_AGENT='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const pageHosts=new Set(['www.xiaohongshu.com','xiaohongshu.com','xhslink.com','xhslink.cn','www.xhslink.com','www.xhslink.cn']);
const decimal=value=>/^[1-9]\d{0,19}$/.test(String(value||''))?String(value):'';
const userId=value=>typeof value==='string'&&/^[a-f0-9]{24}$/.test(value)?value:'';

function safePage(input){
  const url=new URL(input);
  if(url.protocol!=='https:'||url.port||url.username||url.password||!pageHosts.has(url.hostname))throw Error('请使用小红书官方直播或主页分享链接。');
  return url;
}
export function isXiaohongshuLink(input){
  try{return pageHosts.has(new URL(String(input).match(/https?:\/\/[^\s<>]+/)?.[0]).hostname);}catch{return false;}
}
export function safeXiaohongshuStream(input){
  try{
    const url=new URL(input);
    return ['http:','https:'].includes(url.protocol)&&!url.port&&!url.username&&!url.password&&!url.hash&&
      url.hostname.endsWith('.xhscdn.com')&&/^\/live\/[1-9]\d{0,19}\.flv$/.test(url.pathname)?url.href:'';
  }catch{return '';}
}
export function safeXiaohongshuRedirect(input,origin){
  if(!safeXiaohongshuStream(origin))return '';
  try{
    const url=safeXiaohongshuStream(new URL(input,origin).href);
    return url&&new URL(url).pathname===new URL(origin).pathname?url:'';
  }catch{return '';}
}
export function parseXiaohongshuState(html){
  const script=/<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i.exec(html)?.[1]?.trim().replace(/;$/,'');
  if(!script||script.length>2*1024*1024)throw Error('小红书暂未返回可读取的页面状态。');
  // Hydration uses JSON plus bare undefined values. Preserve quoted text and
  // exact uint64 identifiers, and never execute scripts from a remote page.
  const json=script.replace(/"(?:[^"\\]|\\.)*"|\bundefined\b/g,token=>token==='undefined'?'null':token);
  try{return parsePlatformJson(json);}catch{throw Error('小红书页面格式发生变化，等待重新确认。');}
}
export function xiaohongshuMetadata(state,expectedRoom){
  const live=state?.liveStream,room=live?.roomData?.roomInfo,host=live?.roomData?.hostInfo;
  if(live?.liveStatus!=='success'||!room||decimal(room.roomId)!==expectedRoom)throw Error('小红书未返回目标直播间，可能需要重新分享或完成登录验证。');
  let deeplink;
  try{deeplink=new URL(room.deeplink);}catch{throw Error('小红书未返回可核验的主播身份。');}
  if(deeplink.protocol!=='xhsdiscover:'||deeplink.hostname!=='live_audience'||deeplink.searchParams.get('room_id')!==expectedRoom)throw Error('小红书直播间身份不一致，请重新复制分享链接。');
  const ownerId=userId(deeplink.searchParams.get('host_id'));
  if(!ownerId)throw Error('小红书未返回有效的主播身份。');
  // The public H5 distinguishes paid and membership rooms. Never record a
  // preview stream as though it were an unrestricted full broadcast.
  if(room.monetizeType!==0||!Array.isArray(room.joinLimitTypes)||room.joinLimitTypes.some(type=>type!==0))throw Error('这场小红书直播有访问限制，当前不支持录制。');
  if(![2,3,4].includes(room.status))throw Error('小红书直播状态待确认。');
  const streaming=room.status===2;
  let config;
  try{config=typeof room.pullConfig==='string'?parsePlatformJson(room.pullConfig):room.pullConfig;}catch{}
  const candidates=Array.isArray(config?.h264)?config.h264.slice(0,16):[];
  const stream=candidates.map(entry=>({url:safeXiaohongshuStream(entry?.master_url),quality:entry?.quality_type||'H264'}))
    .find(entry=>entry.url&&new URL(entry.url).pathname==='/live/'+expectedRoom+'.flv')||null;
  if(streaming&&!stream)throw Error('这场小红书直播暂未提供可安全录制的 H.264 FLV。');
  return {platform:'xiaohongshu',webRid:expectedRoom,roomId:expectedRoom,ownerId,name:String(host?.nickName||deeplink.searchParams.get('host_nickname')||'小红书主播').slice(0,100),
    title:String(room.roomTitle||host?.nickName||'小红书直播').slice(0,300),streaming,stream:streaming?stream:null};
}

export class XiaohongshuResolver{
  constructor({request=fetch,session}={}){this.request=request;this.session=session;}
  async page(input,{signal=AbortSignal.timeout(12000)}={}){
    const link=String(input).match(/https:\/\/[^\s<>]+/)?.[0]?.replace(/[，。；！）】]+$/u,'');
    if(!link||String(input).length>8192)throw Error('请粘贴小红书直播或主页的完整分享内容。');
    let url=safePage(link),profileUid='';
    const unavailable=message=>Object.assign(Error(message),profileUid?{profileUid}:{});
    for(let hop=0;hop<6;hop++){
      profileUid=/^\/user\/profile\/([a-f0-9]{24})\/?$/.exec(url.pathname)?.[1]||profileUid;
      if(/\/(?:login|website-login)(?:\/|$)/.test(url.pathname))throw unavailable('小红书需要登录或安全验证，请重新分享直播间后重试。');
      const response=await this.request(url,{signal,redirect:'manual',headers:{'User-Agent':XHS_USER_AGENT,Referer:'https://www.xiaohongshu.com/'}});
      const next=response.headers.get('location');
      if(next&&[301,302,303,307,308].includes(response.status)){await response.body?.cancel();url=safePage(new URL(next,url));continue;}
      if(!response.ok){
        await response.body?.cancel();
        throw unavailable('小红书页面访问受限，请稍后重新分享直播间。');
      }
      let html;
      try{html=await readBoundedResponse(response,3*1024*1024);}catch{throw unavailable('小红书页面暂时无法完整读取。');}
      let state;
      try{state=parseXiaohongshuState(html);}catch(error){throw unavailable(error.message);}
      return {url,state,input:link};
    }
    throw Error('小红书分享链接跳转过多，请重新复制链接。');
  }
  async resolve(input,options){
    let page;
    try{page=await this.page(input,options);}
    catch(error){
      if(!error.profileUid)throw error;
      // Retain the requested UID as pending intent. A search result and a
      // matching room owner still have to confirm it before any capture.
      return {kind:'profile',uid:error.profileUid,name:'小红书主播（待确认）'};
    }
    const profile=/^\/user\/profile\/([a-f0-9]{24})\/?$/.exec(page.url.pathname);
    if(profile){
      const info=page.state?.profile?.userInfo;
      if(!info||typeof info.nickname!=='string'||!info.nickname.trim())throw Error('小红书主页暂时无法读取，请使用直播间分享链接。');
      return {kind:'profile',uid:profile[1],name:info.nickname.slice(0,100),input:page.input};
    }
    const path=page.url.pathname.match(/^\/(?:hina\/)?livestream\/(?:[A-Za-z_][A-Za-z0-9_-]{0,79}\/)?([1-9]\d{0,19})(?:\/\d{1,10})?\/?$/);
    if(!path)throw Error('请使用小红书直播或用户主页链接。');
    const metadata=xiaohongshuMetadata(page.state,path[1]);
    const hint=page.url.searchParams.get('host_id');
    if(hint&&hint!==metadata.ownerId)throw Error('小红书分享中的主播身份不一致。');
    return {kind:'room',uid:metadata.ownerId,name:metadata.name,input:page.input,metadata};
  }
  profileStatus(uid,options){return this.session.profile(uid,options);}
  verifyCookie(options){return this.session.verifyCookie(options);}
  async room(id,options){
    if(!decimal(id))throw Error('小红书直播间编号无效。');
    const page=await this.page('https://www.xiaohongshu.com/livestream/'+id,options);
    return xiaohongshuMetadata(page.state,id);
  }
}
