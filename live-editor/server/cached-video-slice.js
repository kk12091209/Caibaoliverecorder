// Cached videos are H.264, constant-frame-rate and have no B frames. Only
// positively verified random-access intervals may be copied into a precise cut.
export function cachedVideoIndex(info,packets,fps){
  if(info.codec!=='h264'||info.bFrames!==0||info.fps!==fps||!info.encodingSignature||
    !Number.isInteger(info.frames)||info.frames<1||info.frames>36000||
    !Array.isArray(packets)||packets.length!==info.frames)return null;
  const keys=[];
  for(let frame=0;frame<packets.length;frame++){
    const p=packets[frame],pts=Number(p.pts_time),dts=Number(p.dts_time);
    if(!Number.isFinite(pts)||!Number.isFinite(dts)||Math.abs(pts-frame/fps)>.00001||
      Math.abs(pts-dts)>.00001||typeof p.flags!=='string'||/[DC]/.test(p.flags))return null;
    if(p.flags.includes('K'))keys.push(frame);
  }
  if(keys[0]!==0)return null;
  return {keys,frames:info.frames,signature:info.encodingSignature};
}

export function splitCachedVideo(part,index,fps){
  const origin=Math.round(part.startMs/1000*fps),from=Math.round(part.from*fps)-origin,to=Math.round(part.to*fps)-origin;
  if(from<0||to>index.frames||to<=from)return null;
  const start=index.keys.find(frame=>frame>=from)??index.frames;
  const end=to===index.frames?to:index.keys.findLast(frame=>frame<=to);
  // Tiny copies rarely repay the probe/mux cost. Short cuts keep one render.
  if(end===undefined||end-start<fps)return null;
  const span=(a,b,copy)=>({...part,from:(origin+a)/fps,to:(origin+b)/fps,
    ...(copy?{reuse:{file:part.cacheFile,from:a/fps,to:b/fps,frames:b-a,signature:index.signature}}:{})});
  return [...(start>from?[span(from,start,false)]:[]),span(start,end,true),...(end<to?[span(end,to,false)]:[])];
}
