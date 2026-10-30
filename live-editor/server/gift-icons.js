import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {safeGiftIcon,giftSegments} from './gifts.js';
import {giftGeometry} from '../shared/gifts.js';
export const giftIconKey=url=>createHash('sha256').update(url).digest('hex');
async function boundedBody(response,maximum){
  if(!response.ok||Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw new Error('礼物图标暂不可用。');}
  const reader=response.body?.getReader();if(!reader)throw new Error('礼物图标为空。');
  const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maximum)throw new Error('礼物图标过大。');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
export function normalizeGiftIcon(bytes,ffmpeg,signal){return new Promise((resolve,reject)=>{
  const child=execFile(ffmpeg,['-v','error','-threads','1','-protocol_whitelist','pipe','-f','image2pipe','-max_pixels','4194304','-i','pipe:0','-frames:v','1','-filter_threads','1',
    '-vf','scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba','-c:v','png','-f','image2pipe','pipe:1'],{encoding:'buffer',maxBuffer:128*1024,timeout:5000,signal},(e,out)=>e?reject(e):resolve(out));
  child.stdin.on('error',()=>{});child.stdin.end(bytes);
});}
export class GiftIcons{
  constructor(store,{ffmpeg='ffmpeg',request=fetch,normalize=normalizeGiftIcon}={}){this.store=store;this.ffmpeg=ffmpeg;this.request=request;this.normalize=normalize;this.pending=new Map();this.abort=new AbortController();this.catalog=new Map();this.catalogUntil=0;}
  close(){this.closed=true;this.abort.abort();}
  async enrich(gifts){
    if(this.closed||!gifts.some(g=>g.platform==='bilibili'&&!g.icon))return gifts;
    if(this.catalogUntil<Date.now()&&!this.catalogWork){
      this.catalogUntil=Date.now()+600000;
      this.catalogWork=(async()=>{try{
        const response=await this.request('https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&source=live',{redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)])});
        const data=JSON.parse((await boundedBody(response,4*1024*1024)).toString());
        for(const g of (data.data?.list||[]).slice(0,4096)){const icon=safeGiftIcon(g.img_basic);if(icon)this.catalog.set(String(g.id),icon);}
      }catch{/* Optional artwork never blocks recording or gift navigation. */}finally{this.catalogWork=null;}})();
    }
    await this.catalogWork;
    if(this.closed)return gifts;
    for(const g of gifts)if(!g.icon&&g.platform==='bilibili'&&this.catalog.has(g.giftId)){
      g.icon=this.catalog.get(g.giftId);this.store.run('UPDATE gift_events SET icon=? WHERE id=?',g.icon,g.id);
      g.iconUrl=`/api/gift-icons/${giftIconKey(g.icon)}.png`;
    }
    return gifts;
  }
  async get(key,{signal:callerSignal}={}){
    if(!/^[a-f0-9]{64}$/.test(key)||this.closed)return null;
    const saved=this.store.get('SELECT png FROM gift_icons WHERE key=?',key);if(saved)return Buffer.from(saved.png);
    const url=this.store.all("SELECT DISTINCT icon FROM gift_events WHERE icon!='' LIMIT 4096").find(g=>giftIconKey(g.icon)===key)?.icon;
    if(!url||!safeGiftIcon(url))return null;
    if(this.pending.has(key))return this.pending.get(key);
    if(this.pending.size>=4)return null;
    const work=(async()=>{try{
      const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(8000),...(callerSignal?[callerSignal]:[])]);
      const bytes=await boundedBody(await this.request(url,{redirect:'error',signal,headers:{Accept:'image/png,image/jpeg,image/webp'}}),2*1024*1024);
      const png=await this.normalize(bytes,this.ffmpeg,signal);
      if(this.closed)return null;
      const budget=this.store.get('SELECT COUNT(*) AS n,COALESCE(SUM(length(png)),0) AS bytes FROM gift_icons');
      if(budget.n<512&&budget.bytes+png.length<=32*1024*1024)this.store.run('INSERT OR IGNORE INTO gift_icons VALUES(?,?,?)',key,png,Date.now());
      return png;
    }catch{return null;}finally{this.pending.delete(key);}})();this.pending.set(key,work);return work;
  }
  async snapshot(gifts,{timeoutMs=8000}={}){
    await this.enrich(gifts);const icons={},signal=AbortSignal.timeout(timeoutMs);
    const urls=[...new Set(gifts.map(g=>g.icon).filter(Boolean))].slice(0,64);let bytes=0,cursor=0;
    // Artwork is optional: one shared deadline prevents many unavailable images
    // from holding an export submission open for minutes.
    await Promise.all(Array.from({length:Math.min(4,urls.length)},async()=>{
      while(cursor<urls.length&&!signal.aborted&&!this.closed){
        const key=giftIconKey(urls[cursor++]),png=await this.get(key,{signal});if(!png||bytes+png.length>2*1024*1024)continue;
        icons[key]=png.toString('base64');bytes+=png.length;
      }
    }));
    return icons;
  }
}
export async function giftIconFilter(gifts,icons,width,height,workDir,{base=0,from=0,to=Infinity}={}){
  const entries=new Map();
  for(const segment of giftSegments(gifts,from,to))for(const [lane,g] of segment.events.entries()){
    const key=g.icon&&giftIconKey(g.icon);if(!key||!icons?.[key])continue;
    const group=key+':'+lane;if(!entries.has(group))entries.set(group,{key,lane,intervals:[]});
    const intervals=entries.get(group).intervals,last=intervals.at(-1);
    if(last&&Math.abs(last[1]-segment.start)<.0001)last[1]=segment.end;else intervals.push([segment.start,segment.end]);
  }
  const filters=[];let n=0;
  for(const {key,lane,intervals} of entries.values()){
    const g=giftGeometry(width,height,lane),file=`gift-${key}.png`,name='gift'+n++;
    await fs.writeFile(path.join(workDir,file),Buffer.from(icons[key],'base64'));
    const enable=intervals.map(([a,b])=>`gte(t,${Math.max(0,a-base).toFixed(4)})*lt(t,${(b-base).toFixed(4)})`).join('+');
    filters.push(`null[${name}v];movie=${file},scale=${Math.round(g.icon)}:${Math.round(g.icon)}[${name}i];[${name}v][${name}i]overlay=x=${Math.round(g.x+g.pad)}:y=${Math.round(g.y+(g.h-g.icon)/2)}:eof_action=repeat:enable='${enable}'`);
  }
  return filters.join(',');
}
