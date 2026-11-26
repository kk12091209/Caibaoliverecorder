import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { giftMetrics, giftOpacity, giftRange } from '../shared/gift-layout.js';
import { overlayTimeExpression } from './overlay-time.js';
import { giftIconKey } from './gift-icons.js';
import {fallbackGiftArtwork} from '../shared/gift-artwork.js';

const color = rgb => rgb.slice(5,7)+rgb.slice(3,5)+rgb.slice(1,3);
const word = text => String(text).replace(/[{}\\\r\n]/g, ' ');
const clock = seconds => {
  const ticks = Math.max(0,Math.round(seconds*100));
  return [Math.floor(ticks/360000),String(Math.floor(ticks/6000)%60).padStart(2,'0'),
    (ticks%6000/100).toFixed(2).padStart(5,'0')].join(':');
};
const alpha = opacity => '\\alpha&H'+Math.round((1-opacity)*255).toString(16).padStart(2,'0')+'&';

function fade(item,start,end) {
  const initial=alpha(giftOpacity(item,start)),final=alpha(giftOpacity(item,end));
  return initial===final?initial:initial+'\\t(0,'+Math.round((end-start)*1000)+','+final+')';
}

function cardPath(width,height,radius,bottom=true) {
  const r=Math.min(Math.round(radius),Math.floor(width/2),Math.floor(height/2));
  if (!r) return 'm 0 0 l '+width+' 0 '+width+' '+height+' 0 '+height;
  const k=Math.round(r*.55),x=width-r,y=height-r;
  return 'm '+r+' 0 l '+x+' 0 b '+(x+k)+' 0 '+width+' '+(r-k)+' '+width+' '+r+
    (bottom?' l '+width+' '+y+' b '+width+' '+(y+k)+' '+(x+k)+' '+height+' '+x+' '+height+
      ' l '+r+' '+height+' b '+(r-k)+' '+height+' 0 '+(y+k)+' 0 '+y:' l '+width+' '+height+' 0 '+height)+
    ' l 0 '+r+' b 0 '+(r-k)+' '+(r-k)+' 0 '+r+' 0';
}
export function giftSubtitles(track,width,height,style,{base=0,from=0,to=Infinity}={}) {
  const m=giftMetrics(width,height,style);
  let output='';
  for (const segment of giftRange(track,from,to)) {
    const start=Math.max(segment.start,from),end=Math.min(segment.end,to);
    const at=clock(start-base),until=clock(end-base);
    if (at===until) continue;
    for (const item of segment.items) {
      const {x,y,w,h,entry}=item;
      const clip='\\clip('+x+','+y+','+(x+w)+','+(y+h)+')';
      const effect=fade(item,start,end);
      const add=(layer,px,py,ink,extra,content,align=7)=>{
        output+='Dialogue: '+layer+','+at+','+until+',Default,,0,0,0,,{\\an'+align+'\\pos('+px+','+py+')'+clip+
          '\\1c&H'+color(ink)+'&\\3c&H141014&\\shad0\\b1\\i0'+effect+extra+'}'+content+'\n';
      };
      if (entry.type==='sc') {
        add(4,x,y,item.background,'\\p1\\bord0',cardPath(w,h,m.radius)+'{\\p0}');
        add(5,x,y,item.header,'\\p1\\bord0',cardPath(w,m.head,m.radius,false)+'{\\p0}');
        const headerSize=Math.round(m.size*.88);
        const titleY=y+Math.floor(m.head/2);
        add(6,x+m.pad,titleY,item.headerInk,'\\bord0\\q2\\fs'+headerSize,word(item.title),4);
        add(6,x+w-m.pad,titleY,item.headerInk,'\\bord0\\q2\\fs'+headerSize,word(item.price),6);
        for (const [line,text] of item.lines.entries()) {
          add(6,x+m.pad,y+m.head+m.pad+line*m.line+Math.floor(m.line/2),
            item.ink,'\\bord'+item.bodyOutline+'\\q2\\fs'+m.size,word(text),4);
        }
      } else {
        const ix=x+m.pad;
        const ink=entry.type==='guard'?'#a6dafa':'#ffffff';
        add(5,ix+m.icon+m.gap,y+Math.floor(h/2),ink,'\\bord'+Math.max(1,m.size*.055)+'\\q2\\fs'+m.size,word(item.label),4);
      }
    }
  }
  return output;
}

export async function giftArtwork(track,icons,width,height,style,workDir,{base=0,from=0,to=Infinity}={}) {
  const m=giftMetrics(width,height,style),entries=new Map();
  for (const segment of giftRange(track,from,to)) for (const item of segment.items) {
    if (item.entry.type==='sc') continue;
    const original=item.entry.icon&&giftIconKey(item.entry.icon);
    const key=original&&icons?.[original]?original:item.entry.type==='guard'?'default-guard':'default-gift';
    const x=item.x+m.pad,y=item.y+Math.floor((item.h-m.icon)/2);
    const start=Math.max(segment.start,from),end=Math.min(segment.end,to);
    if(end<=start)continue;
    const middle=(start+end)/2;
    const interval=(a,b)=>{
      const opacity=Math.round(giftOpacity(item,(a+b)/2)*4)/4;
      if(!opacity)return;
      const slot=key+':'+x+':'+y+':'+opacity;
      if(!entries.has(slot))entries.set(slot,{key,x,y,opacity,intervals:[]});
      entries.get(slot).intervals.push([a-base,b-base]);
    };
    if (Math.abs(giftOpacity(item,start)-giftOpacity(item,end))>.3) {
      interval(start,middle);interval(middle,end);
    } else interval(start,end);
  }
  // Split unusually dense graphs using the existing video-only checkpoint
  // path. Audio is encoded once for the entire parent segment.
  if (entries.size>90 && to-from>2) {
    throw Object.assign(new Error('礼物图标较密集，分段渲染录像。'),{code:'EXPORT_OVERLAY_EXPRESSION',filter:'礼物图标'});
  }
  const filters=[];
  for (const {key,x,y,opacity,intervals} of entries.values()) {
    const file='gift-'+key+'.png',name='giftart'+filters.length;
    const bitmap=icons?.[key]||fallbackGiftArtwork(key==='default-guard'?'guard':'gift');
    await writeFile(path.join(workDir,file),Buffer.from(bitmap,'base64'));
    const enable=overlayTimeExpression(intervals,4);
    const faded=opacity<1?',format=rgba,colorchannelmixer=aa='+opacity:'';
    filters.push('null['+name+'v];movie='+file+',scale='+m.icon+':'+m.icon+faded+'['+name+'i];['+name+'v]['+name+
      "i]overlay=x="+x+':y='+y+":eof_action=repeat:enable='"+enable+"'");
  }
  return filters.join(',');
}
