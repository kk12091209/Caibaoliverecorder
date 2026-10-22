// Keep wall-clock gaps intact: edits and danmaku use this same timeline.
// An unfinished index is not evidence of lost recording.
export function recordingCoverage(sources,total) {
  total=Number.isFinite(total)?Math.max(0,total):0;
  const rows=(sources??[]).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.duration))
    .map(s=>({start:Math.max(0,Math.min(total,s.start)),end:Math.max(0,Math.min(total,s.start+Math.max(0,s.duration))),settled:s.closed===2}))
    .sort((a,b)=>a.start-b.start);
  let end=0,available=0,settled=true;
  const gaps=[];
  for(const row of rows){
    if(row.start>end){if(settled&&row.start-end>=1)gaps.push({start:end,end:row.start});settled=true;}
    available+=Math.max(0,row.end-Math.max(end,row.start));
    end=Math.max(end,row.end);settled=settled&&row.settled;
  }
  if(rows.length&&settled&&total-end>=1)gaps.push({start:end,end:total});
  return {gaps,available,missing:gaps.reduce((sum,gap)=>sum+gap.end-gap.start,0)};
}
