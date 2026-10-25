export const RECORDING_STYLE_SETTING='recording-style';
export const CAMERA_POSITIONS=Object.freeze([
  {value:'bottom-left',label:'左下角'}, {value:'bottom-right',label:'右下角'},
  {value:'top-left',label:'左上角'}, {value:'top-right',label:'右上角'},
  {value:'original',label:'保留原画面'}
]);
export const DEFAULT_RECORDING_STYLE=Object.freeze({cameraPosition:'bottom-left',cameraSize:24});
export function validateRecordingStyle(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['cameraPosition','cameraSize'].includes(k))||
    !CAMERA_POSITIONS.some(p=>p.value===value.cameraPosition)||!Number.isInteger(value.cameraSize)||value.cameraSize<10||value.cameraSize>40)
    throw new Error('请选择有效的摄像头位置和大小（10%–40%）。');
  return {cameraPosition:value.cameraPosition,cameraSize:value.cameraSize};
}
export function normalizedRecordingStyle(value) {try{return validateRecordingStyle(value);}catch{return {...DEFAULT_RECORDING_STYLE};}}
export const savedRecordingStyle=store=>normalizedRecordingStyle(store.setting(RECORDING_STYLE_SETTING));
export const originalRecordingStyle=()=>({...DEFAULT_RECORDING_STYLE,cameraPosition:'original'});

function rect(value) {
  if(!value||!['x','y','w','h'].every(key=>Number.isFinite(value[key])))return null;
  const {x,y,w,h}=value;
  return x>=0&&y>=0&&w>0&&h>0&&x+w<=1.000001&&y+h<=1.000001?{x,y,w:Math.min(w,1-x),h:Math.min(h,1-y)}:null;
}
// Only explicit, non-overlapping source crops can be rearranged. A webcam
// already burned into the game cannot be removed without inventing pixels.
export function cameraLayout(value) {
  const main=rect(value?.main),camera=rect(value?.camera);
  if(!main||!camera)return null;
  if(Math.min(main.x+main.w,camera.x+camera.w)-Math.max(main.x,camera.x)>0.000001&&
    Math.min(main.y+main.h,camera.y+camera.h)-Math.max(main.y,camera.y)>0.000001)return null;
  return {main,camera};
}
export function cameraLayoutAt(events,time) {
  const event=events.findLast(e=>e.time<=time&&time<e.end);
  return cameraLayout(event?.layout);
}
export function blockCameraEvents(events=[],source,from,to) {
  return events.filter(e=>e.source===source&&e.time<to&&e.end>from&&cameraLayout(e.layout))
    .map(e=>({source:e.source,time:Math.max(from,e.time),end:Math.min(to,e.end),layout:cameraLayout(e.layout)}));
}
const even=value=>Math.max(2,Math.floor(value/2)*2);
function cropPixels(r,width,height) {
  const x=Math.min(even(width)-2,Math.floor(r.x*width/2)*2),y=Math.min(even(height)-2,Math.floor(r.y*height/2)*2);
  return {x,y,w:Math.min(even(r.w*width),even(width)-x),h:Math.min(even(r.h*height),even(height)-y)};
}
// Integer chroma-aligned geometry is shared by Canvas and FFmpeg, so both
// versions retain the same camera aspect ratio and padding at any resolution.
export function cameraGeometry(layout,style,sourceWidth,sourceHeight,width=sourceWidth,height=sourceHeight) {
  layout=cameraLayout(layout);style=normalizedRecordingStyle(style);
  if(!layout||style.cameraPosition==='original'||![sourceWidth,sourceHeight,width,height].every(v=>Number.isFinite(v)&&v>=2))return null;
  const main=cropPixels(layout.main,sourceWidth,sourceHeight),camera=cropPixels(layout.camera,sourceWidth,sourceHeight);
  const scale=Math.min(width/main.w,height/main.h),w=even(main.w*scale),h=even(main.h*scale);
  if(w<8||h<8)return null;
  const mainTarget={x:Math.floor((width-w)/4)*2,y:Math.floor((height-h)/4)*2,w,h};
  const margin=Math.max(2,Math.floor(Math.min(w,h)*.02/2)*2);
  const cameraScale=Math.min((w*style.cameraSize/100)/camera.w,(h-2*margin)/camera.h);
  const cw=Math.min(w-2*margin,even(camera.w*cameraScale)),ch=even(camera.h*cameraScale);
  const right=style.cameraPosition.endsWith('right'),bottom=style.cameraPosition.startsWith('bottom');
  return {main,camera,mainTarget,cameraTarget:{x:mainTarget.x+(right?w-margin-cw:margin),y:mainTarget.y+(bottom?h-margin-ch:margin),w:cw,h:ch}};
}
