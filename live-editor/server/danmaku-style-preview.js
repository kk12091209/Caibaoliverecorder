import fs from 'node:fs/promises';
import path from 'node:path';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {assText} from './media.js';
import {validateChatRate} from './chat-rules.js';
import {validateDanmakuStyle,danmakuGeometry} from '../shared/danmaku-style.js';
import {danmakuTextWidth} from '../shared/danmaku-tracks.js';
import {DANMAKU_SAMPLES} from '../shared/danmaku-samples.js';
import {layoutComments} from './render-plan.js';
import {videoGeometryFilter} from './export-encoding.js';

export const STYLE_PREVIEW_WIDTH=1672,STYLE_PREVIEW_HEIGHT=940,STYLE_PREVIEW_TIME=4.65;
export function stylePreviewTime(style,font){
  const {size}=danmakuGeometry(STYLE_PREVIEW_HEIGHT,style);
  // Very large fonts can have left the screen at the default sample time.
  // Freeze earlier on an actual video frame, while the opening samples are
  // still readable. Density changes retain that same frame and placement.
  const width=Math.max(...DANMAKU_SAMPLES.slice(0,2).map(text=>danmakuTextWidth(text,size,font)));
  // 50 ms aligns both 60 fps frames and ASS's centisecond timestamps.
  return Math.min(STYLE_PREVIEW_TIME,Math.floor(STYLE_PREVIEW_WIDTH*6/(STYLE_PREVIEW_WIDTH+width)*20)/20);
}
export function stylePreviewMessages(rate,style,font){
  validateChatRate(rate);
  const step=Math.min(.09,Math.floor(stylePreviewTime(style,font)*100/50)/100);
  return DANMAKU_SAMPLES.slice(0,rate).map((text,index)=>({id:String(index).padStart(2,'0'),type:'d',text,time:Number((index*step).toFixed(2))}));
}
export function stylePreviewEvents(rate,style,font){
  validateChatRate(rate);validateDanmakuStyle(style);
  const time=stylePreviewTime(style,font);
  return layoutComments(stylePreviewMessages(rate,style,font),{rate,width:STYLE_PREVIEW_WIDTH,height:STYLE_PREVIEW_HEIGHT,style,font})
    .filter(event=>event.time<=time&&event.end>time)
    .map(event=>({...event,time:event.time-time,end:event.end-time}));
}
// One bounded single-frame render at a time. The same ASS generator, font file,
// libass renderer and source coordinates are used by the video exports.
export class DanmakuStylePreview{
  constructor(media,{imageRoot=fileURLToPath(new URL('../dist/assets/',import.meta.url))}={}){this.media=media;this.busy=false;this.imageRoot=imageRoot;}
  async render(input,signal){
    if(!input||Object.keys(input).some(key=>!['style','rate','font'].includes(key)))throw new Error('样式预览参数无效。');
    const style=validateDanmakuStyle(input.style),rate=validateChatRate(input.rate);
    if(this.busy)throw Object.assign(new Error('正在更新预览，请稍后重试。'),{status:409});
    this.busy=true;let work;
    try{
      const font=await this.media.fonts.selection(input.font);
      if(signal?.aborted)return null;
      const images=(await fs.readdir(this.imageRoot)).filter(name=>/^danmaku-style-preview-[A-Za-z0-9_-]+\.png$/.test(name));
      if(images.length!==1)throw new Error('预览背景未就绪，请重新构建或安装软件。');
      const background=path.join(this.imageRoot,images[0]),stat=await fs.lstat(background);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('预览背景文件无效。');
      work=await this.media.temporaryDirectory('bili-export-','style-preview');
      const events=stylePreviewEvents(rate,style,font);
      await fs.writeFile(path.join(work,'part-0.ass'),assText(events,STYLE_PREVIEW_WIDTH,STYLE_PREVIEW_HEIGHT,font,style));
      const fonts=await this.media.fonts.stage(font,work),chunks=[];let bytes=0;
      const output=new Writable({write(chunk,_encoding,done){bytes+=chunk.length;if(bytes>16*1024*1024)return done(new Error('样式预览超过大小限制。'));chunks.push(chunk);done();}});
      const geometry=videoGeometryFilter({width:1672,height:941,sampleAspectRatio:'1:1'},STYLE_PREVIEW_WIDTH,STYLE_PREVIEW_HEIGHT);
      await this.media.process(['-i',background,'-filter_threads','1','-vf',`${geometry},format=yuv420p,ass=part-0.ass${fonts?':fontsdir='+fonts:''}`,'-frames:v','1','-c:v','png','-threads','1','-f','image2pipe','pipe:1'],{cwd:work,signal,output,interactive:true});
      if(signal?.aborted)return null;
      if(!bytes)throw new Error('未能生成样式预览。');
      return {bytes:Buffer.concat(chunks),samples:events.length};
    }finally{try{if(work)await this.media.temporaryWorkspaces.finish(work);}finally{this.busy=false;}}
  }
}
