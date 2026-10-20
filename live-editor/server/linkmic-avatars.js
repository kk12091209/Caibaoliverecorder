import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { labelGeometry } from '../shared/linkmic-labels.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const LIMIT=1024*1024;
export function safeAvatarUrl(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
      /^(?:[a-z0-9-]+\.)+(?:douyinpic\.com|byteimg\.com)$/.test(u.hostname)?u.href:'';
  }catch{return '';}
}
export function avatarUrl(user) {
  for(const field of ['avatar_medium','avatar_thumb']) {
    const urls=user?.[field]?.url_list;
    if(Array.isArray(urls))for(const url of urls.slice(0,5))if(safeAvatarUrl(url))return safeAvatarUrl(url);
  }
  return '';
}
export async function downloadAvatar(url,{request=fetch,signal}={}) {
  if(!safeAvatarUrl(url))throw new Error('头像地址无效。');
  const response=await request(url,{redirect:'error',signal,headers:{Accept:'image/png,image/jpeg,image/webp'}});
  if(!response.ok||Number(response.headers.get('content-length'))>LIMIT){
    await response.body?.cancel().catch(()=>{});
    throw new Error('头像暂不可用。');
  }
  const reader=response.body?.getReader();if(!reader)throw new Error('头像为空。');
  let size=0;const chunks=[];
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>LIMIT)throw new Error('头像过大。');chunks.push(value);}
  }finally{await reader.cancel().catch(()=>{});}
  const bytes=Buffer.concat(chunks);
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!png&&!jpeg&&!webp)throw new Error('头像格式无效。');
  return bytes;
}
// Store a small, decoded PNG rather than serving arbitrary remote image bytes.
// The circular alpha is shared by preview and export, including offline playback.
export function normalizeAvatar(bytes,ffmpeg,signal) {
  return new Promise((resolve,reject)=>{
    const child=execFile(ffmpeg,['-v','error','-threads','1','-protocol_whitelist','pipe','-f','image2pipe',
      '-max_pixels','4194304','-i','pipe:0','-frames:v','1','-filter_threads','1',
      '-vf',"scale=128:128:force_original_aspect_ratio=increase,crop=128:128,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-63.5,2)+pow(Y-63.5,2),4096),255,0)'",
      '-c:v','png','-f','image2pipe','pipe:1'],{encoding:'buffer',maxBuffer:256*1024,timeout:8000,signal},
    (error,stdout)=>error?reject(error):resolve(stdout));
    child.stdin.on('error',()=>{});child.stdin.end(bytes);
  });
}
export class LinkmicAvatars {
  constructor(store,{ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',request=fetch,normalize=normalizeAvatar}={}) {
    this.store=store;this.ffmpeg=ffmpeg;this.request=request;this.normalize=normalize;
  }
  async capture(source,channel,person,signal) {
    const url=safeAvatarUrl(person.avatarUrl);if(!url)return;
    const key=hash(url),old=this.store.get('SELECT avatar,avatar_key FROM linkmic_people WHERE source=? AND channel=? AND link_id=?',source.id,channel,person.linkId);
    if(old?.avatar&&old.avatar_key===key)return;
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    const bytes=await downloadAvatar(url,{request:this.request,signal:bounded});
    const png=await this.normalize(bytes,this.ffmpeg,bounded);
    if(bounded.aborted||!this.store.session(source.session))return;
    const id=hash(png);
    this.store.transaction(()=>{
      this.store.run('INSERT OR IGNORE INTO linkmic_avatars(source,hash,png) VALUES(?,?,?)',source.id,id,png);
      this.store.run('UPDATE linkmic_people SET avatar=?,avatar_key=? WHERE source=? AND channel=? AND link_id=? AND id=?',id,key,source.id,channel,person.linkId,person.id);
    });
  }
}

// A filter fragment with one open video input/output, usable in both -vf and
// complex dual-export graphs. Group repeated SEI intervals to decode each image once.
export async function avatarFilter(store,events,width,height,workDir,{base=0,from=0,to=Infinity,sourceWidth=width,sourceHeight=height,prefix='mic'}={}) {
  const cards=new Map();
  for(const event of events)for(const person of event.participants) {
    const g=labelGeometry(person,width,height,sourceWidth,sourceHeight),start=Math.max(from,event.time)-base,end=Math.min(to,event.end)-base;
    if(!g?.audioOnly||end<=start)continue;
    const key=JSON.stringify([event.source,person.avatar,g.left,g.top,g.right,g.bottom]);
    if(!cards.has(key))cards.set(key,{g,source:event.source,avatar:person.avatar,intervals:[]});
    const intervals=cards.get(key).intervals,last=intervals.at(-1);
    if(last&&start<=last[1]+.001)last[1]=Math.max(last[1],end);else intervals.push([start,end]);
  }
  const filters=[];let n=0;
  for(const {g,source,avatar,intervals} of cards.values()) {
    const enable=intervals.map(([a,b])=>`gte(t,${a.toFixed(4)})*lt(t,${b.toFixed(4)})`).join('+');
    filters.push(`drawbox=x=${Math.round(g.left)}:y=${Math.round(g.top)}:w=${Math.round(g.right-g.left)}:h=${Math.round(g.bottom-g.top)}:color=0x35353d@0.80:t=fill:enable='${enable}'`);
    const png=/^[a-f0-9]{64}$/.test(avatar||'')?store.get('SELECT png FROM linkmic_avatars WHERE source=? AND hash=?',source,avatar)?.png:null;
    if(!png)continue;
    const file=`avatar-${avatar}.png`,id=prefix+(n++);
    await fs.writeFile(path.join(workDir,file),png);
    filters.push(`null[${id}v];movie=${file},scale=${Math.round(g.avatarSize)}:${Math.round(g.avatarSize)}[${id}a];[${id}v][${id}a]overlay=x=${Math.round(g.avatarX)}:y=${Math.round(g.avatarY)}:eof_action=repeat:enable='${enable}'`);
  }
  return filters.join(',');
}
