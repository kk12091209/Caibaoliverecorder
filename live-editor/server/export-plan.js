import fs from 'node:fs/promises';
import path from 'node:path';
import {sourceStream,seekBase} from './ingest.js';
import {canCopyFullSource} from './export-encoding.js';
import {codecHeaderSignature} from './source-range-identity.js';

// One timeline is shared by original-picture and burned-in exports. A full
// recording omits unavailable intervals; precise clips must never invent them.
export function exportSegments(sources,ranges,scope) {
  const segments=[];
  for(const range of ranges){
    let cursor=range.start;
    for(const source of sources.filter(s=>s.start<range.end&&s.start+s.duration>range.start)){
      const from=Math.max(cursor,source.start),to=Math.min(range.end,source.start+source.duration);
      if(to<=from)continue;
      if(from-cursor>.15&&scope!=='full')throw new Error('选段跨越直播断流空缺，请分别添加空缺前后的选段，避免伪造缺失画面。');
      segments.push({source,from,to});cursor=to;
    }
    if(range.end-cursor>.15)throw new Error('选段末尾尚未完整写入，请稍后重新导出。');
  }
  return segments;
}

export async function sourceExportPlan(media,job,sources,firstInfo) {
  const segments=exportSegments(sources,job.ranges,job.scope),entries=[];
  for(const segment of segments){
    const {source,from,to}=segment;
    const info=entries.length?await media.probeSource(source,from):firstInfo||await media.probeSource(source,from);
    const base=seekBase(media.store,source.id,from);
    const key=media.store.get('SELECT seq FROM keyframes WHERE source=? ORDER BY time LIMIT 1',source.id);
    // Whole-source reading retains AAC packets before the first video keyframe.
    // Only a small verified startup offset is eligible; sourceStream also
    // checks that the first stored video packet is a random-access frame.
    const wholeFromSource=base>source.start+.001&&base-source.start<=.1&&key?.seq===0;
    entries.push({...segment,info,base,wholeFromSource,whole:canCopyFullSource({scope:'full',ranges:[{start:from,end:to}]},[source],info,wholeFromSource?source.start:base)});
  }
  let reason='';
  if(job.scope!=='full'||job.ranges.length!==1)reason='精确剪辑沿用逐帧处理。';
  else if(!entries.length||entries.some(e=>!e.whole))reason='来源不是完整、兼容且从首个关键帧开始的片段。';
  if(!reason){
    // A sample at the beginning cannot certify a later codec epoch. Require
    // sealed header history and matching decoder configuration across sources.
    let signature;
    for(const entry of entries){
      const rows=media.store.all('SELECT header FROM chunk_identities WHERE source=? ORDER BY seq',entry.source.id);
      const headers=new Set(rows.map(row=>codecHeaderSignature(row.header)));
      const current=JSON.stringify([entry.info.encodingSignature,entry.info.fps,...headers]);
      if(headers.size>1||(entries.length>1||entry.wholeFromSource)&&(!entry.info.encodingSignature||!rows.length||headers.size!==1||signature&&current!==signature)){reason='来源的编码参数或编码头不一致，沿用完整编码。';break;}
      signature=current;
    }
  }
  const canCopyStreams=!reason;
  if(!reason&&(job.linkmicEvents||[]).some(e=>e.participants.length))reason='需要把连麦标注绘入画面。';
  return {entries,segments,duration:segments.reduce((sum,e)=>sum+e.to-e.from,0),canCopyStreams,canCopyOriginal:!reason,reason};
}

const concatPath=file=>path.resolve(file).replace(/\\/g,'/').replace(/'/g,"'\\''");

// Copy complete A/V together so a delayed AAC track keeps its offset relative
// to video at every reconnect. Intermediate files need no faststart pass.
export async function copyOriginal(media,plan,workDir,name='final.mp4') {
  if(!plan.canCopyOriginal)throw new Error('原画面复制条件未通过。');
  const parts=[];let frames=0,signature;
  try{
    for(let index=0;index<plan.entries.length;index++){
      media.assertExportActive?.();
      const entry=plan.entries[index],single=plan.entries.length===1,file=single?name:`original-${index}.mp4`;
      await media.process(['-fflags','+genpts','-threads','2','-f','flv','-i','pipe:0','-t',String(entry.to-entry.from),
        '-map','0:v:0','-map','0:a:0?','-c','copy',...(single?['-movflags','+faststart']:[]),'-y',file],
      {cwd:workDir,stage:'copy',input:sourceStream(media.store,entry.source.id,entry.from,entry.to,{wholeSource:entry.wholeFromSource})});
      const info=await media.probe(path.join(workDir,file));
      if(info.codec!==entry.info.codec||info.width!==entry.info.width||info.height!==entry.info.height||info.fps!==entry.info.fps||
        info.audioStreams!==entry.info.audioStreams||!Number.isFinite(info.frames)||!Number.isFinite(info.duration)||
        Math.abs(info.duration-(entry.to-entry.from))>Math.max(.1,2/entry.info.fps)||
        !info.encodingSignature||signature&&info.encodingSignature!==signature)throw new Error('原画面封装后的时长或编码信息不一致。');
      signature=info.encodingSignature;frames+=info.frames;parts.push({file,duration:entry.to-entry.from});
    }
    if(parts.length>1){
      await fs.writeFile(path.join(workDir,'original-concat.txt'),'ffconcat version 1.0\n'+parts.map(p=>`file '${concatPath(path.join(workDir,p.file))}'\nduration ${p.duration}`).join('\n'));
      await media.process(['-f','concat','-safe','0','-i','original-concat.txt','-map','0:v:0','-map','0:a:0?','-c','copy',
        '-t',String(plan.duration),'-movflags','+faststart','-y',name],{cwd:workDir,stage:'mux'});
      const info=await media.probe(path.join(workDir,name));
      if(info.frames!==frames||!Number.isFinite(info.duration)||Math.abs(info.duration-plan.duration)>Math.max(.1,2/plan.entries[0].info.fps))throw new Error('多段原画面拼接后的帧数或时长不一致。');
    }
    return name;
  }catch(error){media.assertExportActive?.();error.originalCopyFailure=true;throw error;}
}
