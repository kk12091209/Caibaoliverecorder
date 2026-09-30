const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const unit=value=>Math.min(1,Math.max(0,finite(value)));

export function signalWindow(duration,center,span=120) {
  const total=Math.max(0,finite(duration)),length=Math.min(total,Math.max(.001,finite(span,120)));
  const from=Math.max(0,Math.min(total-length,finite(center)-length/2));
  return {from,to:Math.min(total,from+length)};
}
export function viewWindow(duration,window) {
  const total=Math.max(0,finite(duration));if(!window)return {from:0,to:total};
  const from=Math.max(0,Math.min(total,finite(window.from))),to=Math.max(from,Math.min(total,finite(window.to,total)));
  return {from,to};
}
// Navigation changes the visible time window, never the playhead or edit points.
export function panWindow(duration,window,from) {
  const total=Math.max(0,finite(duration)),current=viewWindow(total,window),span=current.to-current.from;
  const start=Math.max(0,Math.min(total-span,finite(from,current.from)));
  return {from:start,to:start+span};
}
export function zoomWindow(duration,window,anchor,factor) {
  const total=Math.max(0,finite(duration));if(!total)return null;
  const current=viewWindow(total,window),length=current.to-current.from,scale=finite(factor,1);
  if(scale<=0||scale===1)return window?current:null;
  // Enter a useful local view directly, even after many hours of recording.
  const requested=!window&&scale<1?Math.min(120,total/2):length*scale;
  const span=Math.min(total,Math.max(Math.min(10,total),requested));
  if(span>=total)return null;
  const point=Number(anchor),center=anchor!==null&&anchor!==undefined&&Number.isFinite(point)&&point>=current.from&&point<=current.to?point:(current.from+current.to)/2;
  return signalWindow(total,center,span);
}
export function windowPercent(time,from,to) {return to>from?(finite(time)-from)/(to-from)*100:0;}
export function visibleRange(range,from,to) {
  if(!range||to<=from)return null;
  const start=Math.max(from,finite(range.start)),end=Math.min(to,finite(range.end));
  return end>start?{left:windowPercent(start,from,to),width:(end-start)/(to-from)*100}:null;
}
export function timeAtPixel(x,width,from,to) {return from+unit(width>0?x/width:0)*Math.max(0,to-from);}

function groups(bins,width) {
  if(!Array.isArray(bins)||!bins.length)return [];
  const columns=Math.max(1,Math.min(bins.length,4096,Math.floor(finite(width,1))));
  return Array.from({length:columns},(_,index)=>bins.slice(Math.floor(index*bins.length/columns),Math.floor((index+1)*bins.length/columns)));
}
export function aggregateAudio(bins,width) {
  return groups(bins,width).map(group=>{
    const ready=group.filter(bin=>['ready','silent'].includes(bin?.state));
    const pending=group.some(bin=>!bin||!['ready','silent','unavailable'].includes(bin.state));
    const unavailable=group.some(bin=>bin?.state==='unavailable');
    return {peak:ready.reduce((peak,bin)=>Math.max(peak,unit(bin.peak)),0),rms:ready.length?Math.sqrt(ready.reduce((sum,bin)=>sum+unit(bin.rms)**2,0)/ready.length):0,
      state:ready.length?(ready.every(bin=>bin.state==='silent')?'silent':'ready'):pending?'pending':'unavailable',pending,unavailable};
  });
}
export function aggregateDensity(bins,width) {return groups(bins,width).map(group=>group.reduce((sum,value)=>sum+Math.max(0,finite(value)),0));}
export function audioStateLabel(audio,{selected=false,loading=false,error=''}={}) {
  if(!selected)return '选择素材后显示波形';
  if(error)return '波形暂不可用';
  if(audio?.status==='no_audio'||audio?.hasAudio===false)return '无音轨';
  const bins=Array.isArray(audio?.bins)?audio.bins:[];
  if(!bins.length)return loading||!audio?'波形准备中…':audio.status==='unavailable'?'波形无法读取':'波形准备中…';
  if(bins.every(bin=>bin?.state==='unavailable'))return '波形无法读取';
  if(bins.some(bin=>bin?.state==='pending')||audio.status==='pending')return bins.some(bin=>bin?.state==='ready')?'波形生成中…':'波形准备中…';
  if(bins.every(bin=>bin?.state==='silent'))return '音频静音';
  return '音频波形';
}
export function densityStateLabel(density,{selected=false,error=''}={}) {
  if(!selected)return '选择素材后显示';
  if(error||density?.status==='error')return '密度暂不可用';
  if(density?.status==='building')return '密度统计中…';
  if(!Array.isArray(density?.bins))return '准备中…';
  return density.bins.some(value=>value>0)?'':'暂无有效弹幕';
}
