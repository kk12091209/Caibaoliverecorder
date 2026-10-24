import fs from 'node:fs/promises';

// Canonical layout still sorts/clones a whole session before its cooperative
// yields. Keep that work bounded while a recorder shares this event loop.
// This gate defers work, never filters comments or changes the final output.
export function liveLayoutWithinBudget(store,id) {
  const comments=store.get('SELECT COUNT(*) AS count FROM (SELECT 1 FROM danmaku WHERE session=? LIMIT 50001)',id).count;
  if(comments>50000)return false;
  const frames=store.get('SELECT COUNT(*) AS count FROM (SELECT 1 FROM linkmic_frames f JOIN sources s ON s.id=f.source WHERE s.session=? LIMIT 10001)',id).count;
  return frames<=10000;
}

// Only sealed full blocks may run while the writer is active. The tail is a
// latency cushion, never proof that an index or codec is ready.
export function liveRenderBlocks(sources,blocks,{tailSeconds=90,blockSeconds=60,rangeStatus}={}) {
  const tail=Number.isFinite(tailSeconds)?Math.max(0,tailSeconds):90;
  const recordedThrough=Math.max(0,...sources.map(source=>source.start+source.duration)),cutoff=recordedThrough-tail;
  const future=blocks.filter(block=>Math.abs(block.endMs-block.startMs-blockSeconds*1000)<.001&&block.endMs/1000>cutoff).map(block=>block.endMs/1000+tail);
  for(const source of sources)if(source.closed!==2)future.push(source.start+(Math.floor(source.duration/blockSeconds)+1)*blockSeconds+tail);
  const nextEligibleAt=future.length?Math.min(...future):null;
  const selected=[];let waiting='tail';
  for(const block of blocks){
    if(Math.abs(block.endMs-block.startMs-blockSeconds*1000)>.001||block.endMs/1000>cutoff)continue;
    const state=rangeStatus?.(block.source,block.startMs/1000,block.endMs/1000);
    if(!state?.ready||!state.codecStable){waiting=state?.codecStable===false?'codec':'metadata';continue;}
    selected.push(block);
  }
  return {blocks:selected,waiting,nextEligibleAt,retryAfterMs:waiting==='tail'&&nextEligibleAt!==null?Math.max(1000,Math.min(30000,Math.ceil((nextEligibleAt-recordedThrough)*1000))):10000};
}

// Normalize precisely the interval which ASS and avatarFilter render. A live
// SEI frame whose end is extended beyond this block must not invalidate it.
export function blockLinkmicEvents(events=[],source,from,to) {
  return events.filter(event=>event.source===source&&event.time<to&&event.end>from&&event.participants?.length)
    .map(event=>({...event,time:Math.max(from,event.time),end:Math.min(to,event.end)}));
}

export async function liveMetadataReady(store,sources,signal) {
  for(const source of sources){
    if(signal?.aborted)return false;
    const current=store.get('SELECT xmlpos,pos FROM sources WHERE id=?',source.id);
    if(!current)return false;
    // ensure() has drained the SEI reader. A missing or lagging index cannot be
    // mistaken for a stream without link-mic overlays.
    const progress=store.setting('linkmic-index:'+source.id);
    if(!progress)return false;
    if(progress.mode==='original'&&progress.pos<current.pos)return false;
    if(progress.mode==='chunks'){
      const latest=store.get('SELECT MAX(seq) AS seq FROM chunks WHERE source=?',source.id);
      if((progress.seq??0)<=(latest?.seq??-1))return false;
    }
    let file;
    try {
      file=await fs.open(source.xml,'r');
      const stat=await file.stat();
      if(!stat.isFile()||current.xmlpos>stat.size)return false;
      const remaining=stat.size-current.xmlpos;
      if(remaining>65536)return false;
      if(remaining){
        const bytes=Buffer.alloc(remaining),read=await file.read(bytes,0,bytes.length,current.xmlpos);
        if(read.bytesRead!==remaining)return false;
        const tail=bytes.toString('utf8');
        // The XML declaration, <i>, whitespace and a currently incomplete final
        // event do not advance xmlpos. Complete unconsumed events do matter.
        if(/<(d|sc|gift|guard|density)\s+[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/.test(tail))return false;
      }
    }catch(error){if(['ENOENT','EACCES'].includes(error.code))return false;throw error;}
    finally{await file?.close();}
  }
  return true;
}
