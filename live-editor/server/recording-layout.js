import {cameraLayout,cameraGeometry,normalizedRecordingStyle} from '../shared/recording-style.js';

export function biliCameraLayout(value) {
  if(!Object.hasOwn(value||{},'MULTI_SCREEN'))return undefined;
  const crops=value.MULTI_SCREEN?.crop_info;
  if(!Array.isArray(crops)||crops.length!==2)return null;
  const one=position=>{const cells=crops.filter(c=>c?.position===position);if(cells.length!==1)return null;const c=cells[0];return {x:c.x,y:c.y,w:c.cx,h:c.cy};};
  return cameraLayout({main:one(0),camera:one(1)});
}
export function douyinCameraLayout(value) {
  if(!value||!['game_clip','camera_clip'].some(key=>Object.hasOwn(value,key)))return undefined;
  if(value.camera_hidden!==undefined&&value.camera_hidden!==0)return null;
  return cameraLayout({main:value.game_clip,camera:value.camera_clip});
}

// One-input/one-output fragment, compatible with both -vf and the dual-output
// graph. Each crop reads the untouched source; inactive intervals keep it.
export function recordingLayoutFilter(events,style,width,height,{sourceWidth=width,sourceHeight=height,base=0,from=0,to=Infinity,prefix='camera',fallback='null'}={}) {
  if(normalizedRecordingStyle(style).cameraPosition==='original')return fallback;
  const groups=new Map();
  for(const e of events) {
    const start=Math.max(from,e.time)-base,end=Math.min(to,e.end)-base;
    const g=cameraGeometry(e.layout,style,sourceWidth,sourceHeight,width,height);
    if(!g||end<=start)continue;
    const key=JSON.stringify(g);if(!groups.has(key))groups.set(key,{g,intervals:[]});
    const intervals=groups.get(key).intervals,last=intervals.at(-1);
    if(last&&start<=last[1]+.00001)last[1]=Math.max(last[1],end);else intervals.push([start,end]);
  }
  if(!groups.size)return fallback;
  // Bound filter graphs for corrupted or continuously changing SEI. This
  // refuses that export instead of silently dropping requested camera layouts.
  if(groups.size>32)throw Object.assign(new Error('这段素材的摄像头布局变化过于频繁，请缩短选段或选择“保留原画面”后导出。'),{code:'CAMERA_LAYOUT_COMPLEX'});
  const ids=[...groups.values()].map((_,i)=>prefix+i),lines=[];
  lines.push(`split=${ids.length+1}[${prefix}raw]${ids.map(id=>`[${id}src]`).join('')}`);
  lines.push(`[${prefix}raw]${fallback||'null'}[${prefix}base0]`);
  for(const [{g,intervals},i]of [...groups.values()].map((g,i)=>[g,i])) {
    const id=ids[i],a=g.main,b=g.camera,m=g.mainTarget,c=g.cameraTarget;
    const enable=intervals.map(([a,b])=>`gte(t,${a.toFixed(6)})*lt(t,${b.toFixed(6)})`).join('+');
    lines.push(`[${id}src]split=2[${id}main][${id}cam]`);
    lines.push(`[${id}main]crop=${a.w}:${a.h}:${a.x}:${a.y},scale=${m.w}:${m.h},pad=${width}:${height}:${m.x}:${m.y}:black,setsar=1[${id}full]`);
    lines.push(`[${id}cam]crop=${b.w}:${b.h}:${b.x}:${b.y},scale=${c.w}:${c.h},setsar=1[${id}small]`);
    lines.push(`[${id}full][${id}small]overlay=${c.x}:${c.y}:eof_action=pass[${id}composite]`);
    lines.push(`[${prefix}base${i}][${id}composite]overlay=0:0:eof_action=pass:enable='${enable}'${i+1<ids.length?`[${prefix}base${i+1}]`:''}`);
  }
  return lines.join(';');
}
