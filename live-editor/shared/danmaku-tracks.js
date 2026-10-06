export const DANMAKU_SECONDS = 6;
export const danmakuText = text => String(text).replace(/[{}\\\r\n]/g, ' ').slice(0, 200);
export const danmakuGap = size => Math.max(12, Math.ceil(size * 0.6));

// Reserve more than a glyph's advance, including outline and font overhang.
// Imported fonts supply their maximum horizontal advance in em units.
export function danmakuTextWidth(text, size, font) {
  const ratio = Math.max(1.25, Number(font?.advanceRatio) || 0);
  return Math.ceil([...danmakuText(text)].length * size * ratio + 8);
}

export function scrollingTracks(messages, { width, lanes, top, lineHeight, size, font, measure, previous = new Map() }) {
  const last = Array(lanes).fill(null), uses=Array(lanes).fill(0), result = [], gap = danmakuGap(size);
  // Visit both ends and then split the gaps. Even sparse traffic uses the
  // bottom half instead of repeatedly taking the first free top row.
  const order=[0],pending=[];
  if(lanes>1){order.push(lanes-1);pending.push([1,lanes-2]);}
  for(let index=0;index<pending.length;index++){
    const [from,to]=pending[index];if(from>to)continue;
    const middle=Math.floor((from+to)/2);order.push(middle);
    pending.push([from,middle-1],[middle+1,to]);
  }
  const ordered = messages.map((message,index)=>({...message,id:message.id??String(index)}))
    .sort((a,b)=>a.time-b.time||(String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0));
  for (const message of ordered) {
    const text = danmakuText(message.text), painted = measure?.(text);
    // Font measurements rasterize the browser sprite, but must not change
    // the shared reservation width or its export-equivalent scroll speed.
    const textWidth = danmakuTextWidth(text,size,font);
    const speed = (width + textWidth) / DANMAKU_SECONDS;
    const canUse = lane => {
      const before = last[lane];
      if (!before || before.end <= message.time) return true;
      // Check both entrance clearance and the clearance when the preceding
      // comment leaves. A longer, faster comment must never catch its tail.
      const separation = Math.max((before.textWidth+gap)/before.speed,(textWidth+gap)/speed);
      return message.time-before.time >= separation;
    };
    const old = previous.get(message.id);
    let lane = old && Number.isInteger(old.lane) && old.lane>=0 && old.lane < lanes && canUse(old.lane) ? old.lane : -1;
    if(lane<0)for(const candidate of order){
      if(canUse(candidate)&&(lane<0||uses[candidate]<uses[lane]))lane=candidate;
    }
    if (lane < 0) continue; // Density is an upper bound; never force a full lane.
    const comment = {...message,text,textWidth,paintWidth:painted??textWidth,lane,y:top+lane*lineHeight,speed,end:message.time+DANMAKU_SECONDS};
    last[lane]=comment;uses[lane]++;result.push(comment);
  }
  return result;
}
