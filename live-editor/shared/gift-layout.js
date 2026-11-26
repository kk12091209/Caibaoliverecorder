import { GIFT_SECONDS, giftPrice, giftYuan } from './gifts.js';
import { cameraGeometry } from './recording-style.js';

const PALETTES = [
  ['#ebe9ee','#525064','#fffafc',5,5], ['#dceaff','#305d9d','#ffffff',8,8],
  ['#d3f3ef','#216c72','#ffffff',8,10], ['#fff0bc','#f2bd59','#392607',10,12],
  ['#ffe6c4','#a34a19','#fffaf4',10,12], ['#ffe1e7','#a32d4d','#ffffff',12,15],
  ['#f5d6e1','#702440','#ffffff',12,15],
];
const CUTS = [30,50,100,500,1000,2000];
const HEX = /^#[a-f0-9]{6}$/i;
export const MAX_GIFT_SECONDS = 15;
export const GIFT_FADE_SECONDS = .2;
const PAGE_SECONDS = 3;
const clipText = text => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const glyphSize = c => /^[\u0020-\u007e]$/.test(c) ? .64 : 1.06;

function shorten(text, capacity) {
  const input = Array.from(clipText(text));
  let length = 0, consumed = 0;
  for (const char of input) {
    length += glyphSize(char);
    if (length > capacity) break;
    consumed++;
  }
  if (consumed === input.length) return input.join('');
  if (consumed && length - glyphSize(input[consumed]) + 1.06 > capacity) consumed--;
  return input.slice(0, consumed).join('') + '…';
}

function wrap(text, capacity) {
  let lines = [], line = '', used = 0;
  for (const c of Array.from(clipText(text)).slice(0, 600)) {
    const size = glyphSize(c);
    if (line && used + size > capacity) {
      lines.push(line.trimEnd());
      line = ''; used = 0;
    }
    if (line || c !== ' ') { line += c; used += size; }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function contrastingText(hex) {
  const rgb = hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179 ? '#141015' : '#ffffff';
}

export function giftMetrics(width, height, style) {
  const scale = Math.min(width, height) / 1080;
  const size = Math.max(5, Math.round(24 * scale * style.textScale / 100));
  const horizontal = Math.ceil(48 * scale), vertical = Math.ceil(42 * scale);
  const column = Math.min(Math.round(420 * scale), Math.floor(width * .35));
  return { width, height, column, horizontal, vertical, size, radius:Math.round(9*scale),
    pad:Math.max(2,Math.round(10*scale)), gap:Math.max(2,Math.round(6*scale)),
    icon:Math.round(size * 1.12), row:Math.round(size * 1.42), head:Math.round(size * 1.48), line:Math.round(size * 1.2) };
}

function safeColumn(metrics, corner, percent, obstacle, minimum) {
  const { column, horizontal, vertical, width, height, gap } = metrics;
  const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
  const x = right ? width - horizontal - column : horizontal;
  let top = vertical, end = height - vertical;
  const maximum = Math.max(minimum, Math.round((end - top) * percent / 100));
  if (obstacle && x < obstacle.x + obstacle.w && x + column > obstacle.x &&
      top < obstacle.y + obstacle.h && end > obstacle.y) {
    const above = obstacle.y - gap, below = obstacle.y + obstacle.h + gap;
    if (bottom ? end - below >= minimum : above - top >= minimum) {
      if (bottom) top = below;
      else end = above;
    } else if (bottom) end = Math.min(end, above);
    else top = Math.max(top, below);
  }
  if (bottom) top=Math.max(top,end-maximum);
  else end=Math.min(end,top+maximum);
  return { x, width:column, top, end, bottom };
}

export function giftRegions(metrics, style, obstacle) {
  const { row, gap, head, line, pad } = metrics;
  const gift = safeColumn(metrics, style.giftCorner, style.giftHeight, obstacle, row);
  const minimum = head + line + 2 * pad + (style.scCorner === style.giftCorner ? row + gap : 0);
  const sc = safeColumn(metrics, style.scCorner, style.scHeight, obstacle, minimum);
  return { gift, sc };
}

function card(entry, m) {
  if (entry.type === 'sc') {
    const lines = wrap(entry.text, (m.column - 2 * m.pad) / m.size);
    const amount = giftYuan(entry);
    const [head, color, text, short, long] = PALETTES[amount === null ? 0 : CUTS.filter(value=>amount>=value).length];
    const background = HEX.test(entry.bodyColor || '') ? entry.bodyColor : color;
    const header = HEX.test(entry.headColor || '') ? entry.headColor : head;
    const price = giftPrice(entry);
    const priceWidth = Array.from(price).reduce((sum,c)=>sum+glyphSize(c),0)*m.size;
    const title = shorten(entry.user, (m.column-3*m.pad-priceWidth)/m.size);
    const duration = Math.min(lines.length >= 3 ? long : short, entry.platformSeconds > 0 ? entry.platformSeconds : Infinity);
    return { entry, title, price, lines, header, background, headerInk:contrastingText(header),
      ink:background===color ? text : contrastingText(background), duration };
  }
  const guard = entry.type === 'guard';
  const suffix = guard ? ' 开通了'+entry.name : ' 送出 '+entry.name+' ×'+entry.count;
  const maximum = (m.column-m.icon-m.gap-2*m.pad)/m.size;
  const suffixWidth = Array.from(suffix).reduce((width,c)=>width+glyphSize(c),0);
  const label = suffixWidth < maximum-2
    ? shorten(entry.user, maximum - suffixWidth) + suffix
    : shorten(entry.name, maximum - 5) + (guard ? '' : ' ×'+entry.count);
  return { entry, label, duration:GIFT_SECONDS };
}

function placeList(cards, zone, heightOf, gap) {
  const placed = [];
  let y = zone.bottom ? zone.end : zone.top;
  for (const card of cards) {
    const height = heightOf(card);
    const top = zone.bottom ? y-height : y;
    if (top < zone.top || top+height > zone.end) break;
    placed.push({ ...card, x:zone.x, y:top, w:zone.width, h:height, bottom:zone.bottom });
    y = zone.bottom ? top-gap : top+height+gap;
  }
  return placed;
}

function reserveGift(sc, gifts, gap) {
  if (!gifts.length || gifts[0].x !== sc.x) return sc;
  const newest = gifts[0], oldest = gifts.at(-1);
  const top = Math.min(newest.y, oldest.y), end = Math.max(newest.y+newest.h,oldest.y+oldest.h);
  if (end+gap <= sc.top || top-gap >= sc.end) return sc;
  if (newest.bottom) return { ...sc, end:Math.min(sc.end,top-gap) };
  return { ...sc, top:Math.max(sc.top,end+gap) };
}

function allocate(queue, metrics, style, time, obstacle) {
  const { row, head, line, pad, gap, width, column, vertical } = metrics;
  const { gift, sc } = giftRegions(metrics, style, obstacle);
  const firstGift = placeList(queue.gift.slice(0,1),gift,()=>row,gap);
  const available = reserveGift(sc,firstGift,gap);
  const minimum = head+2*pad;
  const maxLines = Math.floor((available.end-available.top-minimum)/line);
  const chats = [];
  if (maxLines >= 1) for (const [index,item] of queue.sc.entries()) {
    if (item.lines.length > maxLines && index > 0) break;
    const page=Math.max(0,Math.min(Math.floor((time-item.start)/PAGE_SECONDS),Math.ceil(item.lines.length/maxLines)-1));
    const lines=item.lines.slice(page*maxLines,(page+1)*maxLines);
    if ((page+1)*maxLines<item.lines.length && item.start+(page+1)*PAGE_SECONDS>=item.end) {
      const capacity=(metrics.column-2*pad)/metrics.size;
      lines[lines.length-1]=shorten(lines.at(-1)+' …',capacity);
    }
    chats.push({...item,lines});
  }
  let availableGifts = placeList(queue.gift,gift,()=>row,gap);
  const heightOf = item => minimum + item.lines.length * line;
  const fitted = placeList(chats,available,heightOf,gap);
  let fittedChat = placeList(chats,reserveGift(sc,availableGifts,gap),heightOf,gap);
  while (fittedChat.length < fitted.length && availableGifts.length > 1) {
    availableGifts.pop();
    fittedChat = placeList(chats,reserveGift(sc,availableGifts,gap),heightOf,gap);
  }
  for (const [key, items] of [['gift',availableGifts],['sc',fittedChat]]) {
    // An event pushed off a full edge is retired, including after a seek.
    // A camera can temporarily occupy a whole slot without retiring new events.
    if (items.length) queue[key].length = items.length;
  }
  const output = [...availableGifts,...fittedChat];
  if (queue.guard[0]) {
    const center = { x:Math.round((width-column)/2),width:column,top:vertical,end:metrics.height-vertical,bottom:false };
    if (obstacle && center.x < obstacle.x+obstacle.w && center.x+column > obstacle.x && center.top+row > obstacle.y) {
      center.top = Math.max(center.top,obstacle.y+obstacle.h+gap);
    }
    // On narrow video the banner may touch a side column. Use its first free row.
    for (const item of output.slice().sort((a,b)=>a.y-b.y)) {
      if (item.x < center.x+column && item.x+column > center.x && item.y < center.top+row+gap && item.y+item.h > center.top) {
        center.top = item.y+item.h+gap;
      }
    }
    output.push(...placeList(queue.guard,center,()=>row,gap));
  }
  return output;
}

function overlaps(a,b) {
  return a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
}

function appendFrames(track, previous, items, start, end) {
  if (!items.length) return;
  const last = new Map(previous.map(item=>[item.entry.id,item]));
  const stay = items.filter(item=>last.has(item.entry.id));
  const slide = stay.some(item=>last.get(item.entry.id).y!==item.y);
  const steady = {start,end,items};
  if (!slide || end-start<.04) {track.push(steady);return;}
  const movingFor = Math.min(.12,end-start);
  const frames=[];
  for(let step=0;step<3;step++){
    const fraction=step/3;
    const moved=stay.map(item=>{
      const before=last.get(item.entry.id);
      if (item.w!==before.w||item.h!==before.h||item.x!==before.x) return item;
      return {...item,y:Math.round(before.y+(item.y-before.y)*fraction)};
    });
    if(moved.some((item,index)=>moved.slice(0,index).some(other=>overlaps(item,other)))) {
      track.push(steady);
      return;
    }
    const visible=items.filter(item=>!last.has(item.entry.id)&&!moved.some(other=>overlaps(item,other)));
    frames.push({start:start+movingFor*fraction,end:start+movingFor*(step+1)/3,items:[...moved,...visible]});
  }
  track.push(...frames);
  if(start+movingFor<end)track.push({...steady,start:start+movingFor});
}

function lowerBound(segments,time) {
  let left = 0, right = segments.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (segments[mid].end <= time) left = mid+1;
    else right = mid;
  }
  return left;
}

export function giftFrame(track,time) {
  const segment = track[lowerBound(track,time)];
  return segment?.start <= time ? segment.items : [];
}

export function giftRange(track,from,to) {
  let index = lowerBound(track,from);
  const result = [];
  while (index < track.length && track[index].start < to) result.push(track[index++]);
  return result;
}

export function giftOpacity(item,time) {
  return Math.max(0,Math.min(1,(time-item.start)/.12,(item.end-time)/GIFT_FADE_SECONDS));
}

export function giftTimeline(events, width, height, style, { cameraEvents = [], recordingStyle, cameraSizeAt } = {}) {
  const metrics = giftMetrics(width,height,style);
  const changes = new Map();
  const add = (time, item) => {
    if (!changes.has(time)) changes.set(time,[]);
    if (item) changes.get(time).push(item);
  };
  for (const event of events) {
    if (!['gift','sc','guard'].includes(event.type) || !Number.isFinite(event.time)) continue;
    const normalized = card(event, metrics);
    const middle = event.type === 'guard' && event.platform === 'bilibili' && style.guardPosition === 'top-center';
    const key = middle ? 'guard' : event.type === 'sc' ? 'sc' : 'gift';
    const start = event.time, end = start + (middle ? 6 : normalized.duration);
    add(start,{...normalized,key,start,end});add(start+.12);add(Math.max(start,end-GIFT_FADE_SECONDS));add(end);
    if (normalized.lines?.length > 1) {
      for (let time=start+PAGE_SECONDS;time<end;time+=PAGE_SECONDS) add(time);
    }
    for (const update of event.updates || []) if (update.time > start && Number.isFinite(update.time)) {
      add(update.time,{...card({...event,count:update.count},metrics),key,start:update.time,end:update.time+GIFT_SECONDS,update:true});
      add(update.time+GIFT_SECONDS-GIFT_FADE_SECONDS);add(update.time+GIFT_SECONDS);
    }
  }
  for (const camera of cameraEvents) { add(camera.time);add(camera.end); }
  const cameras = cameraEvents.map(event=>{
    const size = cameraSizeAt?.(event) || {width,height};
    return {...event, geometry:cameraGeometry(event.layout,recordingStyle,size.width,size.height,width,height)?.cameraTarget};
  }).sort((a,b)=>a.time-b.time);
  let cameraIndex = -1, previous = [], previousObstacle;
  const queue = {gift:[],sc:[],guard:[]}, track = [];
  const cuts = [...changes.keys()].sort((a,b)=>a-b);
  for (let index=0;index+1<cuts.length;index++) {
    const start = cuts[index], end = cuts[index+1];
    for (const key of Object.keys(queue)) queue[key] = queue[key].filter(item=>item.end>start);
    for (const item of changes.get(start).sort((a,b)=>String(a.entry.id).localeCompare(String(b.entry.id)))) {
      const lines = queue[item.key];
      if (item.update) {
        const current = lines.findIndex(line=>line.entry.id===item.entry.id);
        if (current>=0) lines[current]={...item,start:lines[current].start};
      } else {
        lines.unshift(item);
        // The upper bound is derived from real lane height at this resolution.
        const limit = item.key==='guard' ? 1 : Math.ceil(height / (item.key==='sc' ? metrics.head+metrics.line : metrics.row));
        if (lines.length>limit) lines.length=limit;
      }
    }
    while (cameras[cameraIndex+1]?.time <= start) cameraIndex++;
    const camera = cameras[cameraIndex];
    const obstacle=camera?.end>start?camera.geometry:undefined;
    const items=allocate(queue,metrics,style,start,obstacle);
    appendFrames(track,previousObstacle===obstacle?previous:[],items,start,end);
    previous=items;
    previousObstacle=obstacle;
  }
  return track;
}
