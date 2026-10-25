import { randomBytes } from 'node:crypto';
import {BlockList,isIP} from 'node:net';
import { signRoomQuery } from './douyin-signing.js';
import { parsePlatformJson } from './linkmic-sei.js';
import { labelText } from '../shared/linkmic-labels.js';
import { avatarUrl } from './linkmic-avatars.js';
import { douyinCameraLayout } from './recording-layout.js';

export const DOUYIN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const roomHosts = new Set(['live.douyin.com','douyin.com','www.douyin.com','v.douyin.com','m.douyin.com','webcast.amemv.com']);
const streamHosts = ['.douyincdn.com','.douyinliving.com','.bytecdntp.com','.douyinvod.com','.bytecdn.cn','.snssdk.com','.douyin.com'];
const nonPublicV4=new BlockList(),nonPublicV6=new BlockList(),globalV6=new BlockList();
for(const [address,prefix]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])nonPublicV4.addSubnet(address,prefix,'ipv4');
globalV6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix]of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])nonPublicV6.addSubnet(address,prefix,'ipv6');
export function safeDouyinLink(url) {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !roomHosts.has(url.hostname)) throw new Error('请使用抖音直播间链接。');
  return url;
}
export function isDouyinLink(input) {
  const link = String(input).match(/https?:\/\/[^\s<>]+/)?.[0] || '';
  try { return roomHosts.has(new URL(link).hostname); } catch { return false; }
}
export async function readBoundedResponse(response, maxBytes = 8 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`抖音请求失败：${response.status}`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error('抖音响应数据过大。'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function reflowWebRid(html,url) {
  const roomId=url.hostname==='webcast.amemv.com'&&/^\/douyin\/webcast\/reflow\/([1-9]\d{0,19})\/?$/.exec(url.pathname)?.[1];
  if(!roomId)return '';
  // Mobile shares embed the requested room in React Flight data. Parse only
  // JSON, never run page scripts or take a room from a recommendation.
  const chunks=[];
  for(const match of html.matchAll(/<script\b[^>]*>\s*self\.__rsc_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/gi)) {
    if(chunks.length>=128)return '';
    try{const value=JSON.parse(match[1]);if(value[0]===1&&typeof value[1]==='string')chunks.push(value[1]);}catch{}
  }
  const ids=new Set();
  for(let i=0;i<chunks.length;i++)for(const start of chunks[i].matchAll(/(?:^|\n)[\da-f]+:(?=\[)/gi)) {
    // Flight text records are length-delimited and need not end in a newline.
    // A new script chunk can begin the model record immediately after one.
    let line=chunks[i].slice(start.index+start[0].length);
    for(let j=i+1;!line.includes('\n')&&j<chunks.length;j++)line+=chunks[j];
    line=line.split('\n',1)[0];
    try {
      const node=JSON.parse(line),props=node?.[3],room=props?.data?.room;
      if(node?.[0]!=='$'||props.hasError!==false||props.id!==roomId||room?.idStr!==roomId)continue;
      const webRid=room.owner?.webRid;
      if(typeof webRid==='string'&&/^[1-9]\d{0,19}$/.test(webRid)&&Array.isArray(room.owner?.ownRoom?.roomIdsStr)&&room.owner.ownRoom.roomIdsStr.includes(roomId))ids.add(webRid);
    }catch{}
  }
  return ids.size===1?[...ids][0]:'';
}
export async function resolveDouyinLink(input, { request = fetch, signal } = {}) {
  const link = String(input).match(/https?:\/\/[^\s<>]+/)?.[0]?.replace(/[，。；！）】]+$/u, '');
  if (!link) throw new Error('请粘贴抖音直播间链接。');
  let url = safeDouyinLink(new URL(link));
  for (let attempt = 0; attempt < 6; attempt++) {
    const match = url.hostname === 'live.douyin.com' && /^\/(\d{1,20})\/?$/.exec(url.pathname);
    if (match) return { platform: 'douyin', webRid: match[1], key: 'douyin:' + match[1], url: 'https://live.douyin.com/' + match[1] };
    const explicitRoomPage=url.hostname==='live.douyin.com'&&(url.pathname==='/'||url.pathname.startsWith('/categorynew/'))||
      url.hostname==='www.douyin.com'&&url.pathname.startsWith('/search/')&&url.searchParams.get('type')==='live';
    if(explicitRoomPage&&url.searchParams.has('live_web_rid')){
      const values=url.searchParams.getAll('live_web_rid');
      if(values.length!==1||!/^\d{1,20}$/.test(values[0]))throw new Error('抖音房间编号无效。');
      return {platform:'douyin',webRid:values[0],key:'douyin:'+values[0],url:'https://live.douyin.com/'+values[0]};
    }
    const response = await request(url, { redirect: 'manual', signal: signal || AbortSignal.timeout(12000), headers: { 'User-Agent': DOUYIN_USER_AGENT } });
    const next = response.headers.get('location');
    if (next) { await response.body?.cancel(); url = safeDouyinLink(new URL(next, url)); continue; }
    const html = await readBoundedResponse(response);
    const sharedRoom=reflowWebRid(html,url);
    if(sharedRoom)return resolveDouyinLink('https://live.douyin.com/'+sharedRoom,{request,signal});
    // A page can contain recommended rooms. Only an explicit canonical live
    // link identifies the shared room; never pick the first recommendation.
    const canonical=html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["'](https:\/\/live\.douyin\.com\/\d{1,20})\/?["']/i)?.[1];
    if(canonical)return resolveDouyinLink(canonical,{request,signal});
    throw new Error('未找到直播间，请使用 live.douyin.com 的直播链接。');
  }
  throw new Error('分享链接跳转过多，请使用完整直播链接。');
}
export function safeStreamUrl(input) {
  // Some official origin CDN endpoints support HTTP only. No account cookie is
  // sent to media hosts; host/redirect validation still applies to every hop.
  try { const url = new URL(input); return ['http:','https:'].includes(url.protocol) && !url.port && !url.username && !url.password &&
    streamHosts.some(host => url.hostname.endsWith(host)) ? url.href : ''; } catch { return ''; }
}
export function safeStreamRedirect(input,origin) {
  // Public literal IPs are accepted only in a redirect chain rooted at a
  // validated platform CDN. Never accept local/special IPs or send cookies.
  if(!safeStreamUrl(origin))return '';
  try {
    const url=new URL(input,origin),known=safeStreamUrl(url.href);if(known)return known;
    if(!['http:','https:'].includes(url.protocol)||url.port||url.username||url.password)return '';
    const address=url.hostname.replace(/^\[|\]$/g,''),family=isIP(address);
    const publicIp=family===4?!nonPublicV4.check(address,'ipv4')
      :family===6&&globalV6.check(address,'ipv6')&&!nonPublicV6.check(address,'ipv6');
    return publicIp?url.href:'';
  }catch{return '';}
}
export function selectDouyinFlv(stream = {}) {
  const candidates = [], incompatible=new Set(),priorities = { origin:100,uhd:90,FULL_HD1:80,hd:80,HD1:60,sd:50,SD2:40,SD1:20,ld:20,md:10 };
  for (const [quality, input] of Object.entries(stream.flv_pull_url || {})) {
    const url = safeStreamUrl(input); if (url && !/h265|hevc|av1/i.test(quality)) candidates.push({ quality, url, priority: priorities[quality] || priorities[quality.toLowerCase()] || 10, bitrate: 0 });
  }
  try {
    const sdk = stream.live_core_sdk_data?.pull_data?.stream_data;
    const data = typeof sdk === 'string' ? JSON.parse(sdk) : sdk;
    for (const [quality, entry] of Object.entries(data?.data || {})) {
      if(quality==='ao')continue;
      // The room API can return a separate compatible backup CDN for each
      // quality. Keep main first when both offer the same quality and bitrate.
      for (const variant of [entry?.main, entry?.backup]) {
        if(!variant)continue;
        let parameters;try{parameters=typeof variant.sdk_params==='string'?JSON.parse(variant.sdk_params):variant.sdk_params||{};}catch{continue;}
        const url = safeStreamUrl(variant.flv), codec = String(parameters?.VCodec || parameters?.vcodec || parameters?.codec || '');
        if(url&&/h265|hevc|av1/i.test(codec)){incompatible.add(url);continue;}
        if (url) candidates.push({ quality, url, priority: priorities[quality] || priorities[quality.toLowerCase()] || 10, bitrate: Number(parameters?.vbitrate) || 0 });
      }
    }
  } catch { /* A valid ordinary FLV list remains usable when an optional SDK field is malformed. */ }
  candidates.sort((a, b) => b.priority - a.priority || b.bitrate - a.bitrate);
  return candidates.find(candidate=>!incompatible.has(candidate.url)) || null;
}

export function selectDouyinIndependentFlv(stream={}) {
  // The web player pairs a pull_data's stream_data and extension. Never apply
  // coordinates from another quality, an unrelated stream or the legacy mix.
  const entries=Object.values(stream.pull_datas||{}).slice(0,16),candidates=[];
  for(const entry of entries) {
    const layout=douyinCameraLayout(entry?.extension);if(!layout)continue;
    const selected=selectDouyinFlv({live_core_sdk_data:{pull_data:entry}});
    if(selected)candidates.push({...selected,cameraLayout:layout});
  }
  return candidates.sort((a,b)=>b.priority-a.priority||b.bitrate-a.bitrate)[0]||null;
}

export class DouyinResolver {
  constructor({ request = fetch, now = Date.now, credentials } = {}) { this.request = request; this.now = now; this.credentials=credentials;this.visitor = null; this.refreshing = null;this.authIdentity=(randomBytes(8).readBigUInt64BE() & 9223372036854775807n).toString(); }
  async cookie(signal) {
    const saved=this.credentials?.get('douyin');
    if(saved)return {cookie:saved,userUniqueId:this.authIdentity,expires:Infinity};
    if (this.visitor && this.visitor.expires > this.now()) return this.visitor;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.request('https://live.douyin.com/', { signal:AbortSignal.timeout(15000), redirect:'error', headers: { 'User-Agent': DOUYIN_USER_AGENT } });
      await readBoundedResponse(response);
      const cookies = (response.headers.getSetCookie?.() || []).map(entry => entry.split(';')[0]).filter(entry => /^(?:ttwid|UIFID|UIFID_TEMP|__ac_nonce)=/.test(entry));
      const cookie = cookies.join('; '), ttwid = cookies.find(entry => entry.startsWith('ttwid='));
      if (!ttwid || cookie.length > 16384) throw new Error('暂时无法获取抖音访客信息，请稍后重试。');
      this.visitor = { cookie, expires: this.now() + 10 * 60 * 1000, userUniqueId: (randomBytes(8).readBigUInt64BE() & 9223372036854775807n).toString() };
      return this.visitor;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async room(webRid, { signal } = {}) {
    if (!/^\d{1,20}$/.test(webRid)) throw new Error('抖音房间编号无效。');
    signal ||= AbortSignal.timeout(15000);
    const visitor = await this.cookie(signal);
    const query = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web',
      language: 'zh-CN', web_rid: webRid, browser_name: 'Chrome', browser_version: '140.0.0.0', browser_language: 'zh-CN',
      browser_platform: 'Win32', is_need_double_stream: 'true', msToken: '' });
    const url = 'https://live.douyin.com/webcast/room/web/enter/?' + query + '&a_bogus=' + encodeURIComponent(signRoomQuery(query.toString(), DOUYIN_USER_AGENT));
    const response = await this.request(url, { signal, redirect:'error', headers: { 'User-Agent': DOUYIN_USER_AGENT, Referer: 'https://live.douyin.com/', Cookie: visitor.cookie } });
    let data; try { data = JSON.parse(await readBoundedResponse(response)); } catch (error) { this.visitor = null; throw new Error('抖音暂时未返回直播信息，请稍后重试。', { cause: error }); }
    if(data.status_code===0&&Array.isArray(data.data?.data)&&data.data.data.length===0){
      // An identified anchor can be offline before a webcast room exists.
      const owner=data.data.user;
      if(/^\d{1,20}$/.test(owner?.id_str||'')&&BigInt(owner.id_str)>0n&&typeof owner.nickname==='string'&&owner.nickname.trim())return {platform:'douyin',webRid,ownerId:owner.id_str,roomId:'',streaming:false,title:'',name:owner.nickname.slice(0,100),stream:null,cookie:visitor.cookie,userUniqueId:visitor.userUniqueId};
      const error=new Error('未找到抖音直播间。');error.code='ROOM_NOT_FOUND';throw error;
    }
    const room = data?.data?.data?.[0];
    if (data.status_code !== 0 || !room || ![2,3,4].includes(Number(room.status))) throw new Error('抖音直播信息无效，请稍后重试。');
    const roomId = String(room.id_str || ''), stream = Number(room.status) === 2 ? selectDouyinIndependentFlv(room.stream_url)||selectDouyinFlv(room.stream_url) : null;
    if (!/^\d{1,20}$/.test(roomId)) throw new Error('抖音未返回有效房间编号。');
    return { platform: 'douyin', webRid, roomId, streaming: Number(room.status) === 2,
      ownerId:String(room.owner?.id_str||data.data.user?.id_str||''),
      title: String(room.title || '抖音直播').slice(0,300), name: String(room.owner?.nickname || data.data.user?.nickname || '抖音直播间').slice(0,100),
      stream, cookie: visitor.cookie, userUniqueId: visitor.userUniqueId };
  }
  async linkmic({roomId,anchorId,channel,version,signal}) {
    if(![roomId,anchorId,channel].every(value=>/^\d{1,20}$/.test(value)))throw new Error('连麦房间编号无效。');
    signal=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    const visitor=await this.cookie(signal);
    const audience=version===15;
    const query=new URLSearchParams({aid:'6383',app_name:'douyin_web',live_id:'1',device_platform:'web',
      room_id:roomId,anchor_id:anchorId,...(audience?{}:{channel_id:channel,offset:'0',count:'50',link_status:'4',
        scene:version===2?'1':'7',request_source:version===2?'audience_enter_room':'receive_multi_linker_sei'})});
    const endpoint=audience?'/webcast/linkmic_audience/list/v2/':'/webcast/linkmic/list/';
    const response=await this.request('https://live.douyin.com'+endpoint+'?'+query+'&a_bogus='+encodeURIComponent(signRoomQuery(query.toString(),DOUYIN_USER_AGENT)),
      {signal,redirect:'error',headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:'https://live.douyin.com/',Cookie:visitor.cookie}});
    const result=parsePlatformJson(await readBoundedResponse(response,2*1024*1024));
    if(result.status_code!==0||!Array.isArray(result.data?.user))throw new Error('连麦名单暂时不可用。');
    return result.data.user.slice(0,64).map(entry=>({linkId:String(entry.linkmic_id_str||''),id:String(entry.user?.id_str||''),name:labelText(entry.user?.nickname),avatarUrl:avatarUrl(entry.user),...(/^[1-9]\d{0,19}$/.test(entry.user?.web_rid||'')?{webRid:entry.user.web_rid}:{})}))
      .filter(person=>/^[\w-]{1,100}$/.test(person.linkId)&&/^\d{1,20}$/.test(person.id));
  }
  async verifyCookie(){
    const visitor=await this.cookie(),query=new URLSearchParams({aid:'6383',app_name:'douyin_web',live_id:'1',device_platform:'web',room_id:'0'});
    const response=await this.request('https://live.douyin.com/webcast/user/me/?'+query+'&a_bogus='+encodeURIComponent(signRoomQuery(query.toString(),DOUYIN_USER_AGENT)),
      {signal:AbortSignal.timeout(12000),redirect:'error',headers:{'User-Agent':DOUYIN_USER_AGENT,Referer:'https://live.douyin.com/',Cookie:visitor.cookie}});
    const data=parsePlatformJson(await readBoundedResponse(response,1024*1024));
    return data.status_code===0&&/^[1-9]\d{0,19}$/.test(String(data.data?.id_str||''));
  }
}
