// The editor's recording clock uses Beijing time, independently of the OS zone.
const OFFSET_MS=8*60*60*1000;
const EPSILON_SECONDS=.000001;
const INVALID_INPUT='请填写有效的录制日期和时间（北京时间）。';
const pad=(value,width=2)=>String(value).padStart(width,'0');

function civilMilliseconds(year,month,day,hour,minute,second,millisecond) {
  if(year<1||year>9999||month<1||month>12||day<1||day>31||hour<0||hour>23||minute<0||minute>59||second<0||second>59)return null;
  // Date.UTC treats years 0..99 specially; explicit setters do not.
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,millisecond);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return date.getTime();
}
function metadataTime(value) {
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/i.exec(value);
  if(!match)return null;
  const local=civilMilliseconds(...match.slice(1,7).map(Number),Number((match[7]||'').padEnd(3,'0').slice(0,3)));
  if(local===null)return null;
  const zone=match[8];let offset=OFFSET_MS;
  if(zone?.toUpperCase()==='Z')offset=0;
  else if(zone){const hours=Number(zone.slice(1,3)),minutes=Number(zone.slice(4,6));if(hours>23||minutes>59)return null;offset=(zone[0]==='-'?-1:1)*(hours*60+minutes)*60000;}
  return local-offset;
}
function spansFor(session,sources,duration=session?.duration) {
  const limit=Number.isFinite(duration)&&duration>=0?duration:Infinity;
  const created=metadataTime(session?.created);
  if(!Array.isArray(sources)||!sources.length)return created!==null&&Number.isFinite(limit)&&limit>0?[{start:0,end:limit,wall:created}]:[];
  return sources.flatMap(source=>{
    const start=source.start,end=Math.min(start+source.duration,limit);
    if(!Number.isFinite(start)||!Number.isFinite(source.duration)||start<0||end<=start)return [];
    const recorded=metadataTime(source.wall),wall=recorded??(created===null?null:created+start*1000);
    return wall===null?[]:[{start,end,wall}];
  }).sort((a,b)=>a.start-b.start);
}

export function parseRecordingInput(value) {
  if(typeof value!=='string')throw new Error(INVALID_INPUT);
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if(!match)throw new Error(INVALID_INPUT);
  const local=civilMilliseconds(Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4]),Number(match[5]),Number(match[6]||0),Number((match[7]||'').padEnd(3,'0')));
  if(local===null)throw new Error(INVALID_INPUT);
  return local-OFFSET_MS;
}
export function toRecordingInput(epochMs) {
  if(!Number.isFinite(epochMs))throw new Error(INVALID_INPUT);
  const date=new Date(Math.round(epochMs)+OFFSET_MS),year=date.getUTCFullYear();
  if(!Number.isFinite(date.getTime())||year<1||year>9999)throw new Error(INVALID_INPUT);
  return `${pad(year,4)}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(),3)}`;
}
export function recordingTimeAt(seconds,session,sources) {
  if(!Number.isFinite(seconds)||seconds<0)return null;
  const spans=spansFor(session,sources);
  // Start-inclusive intervals agree with playback/export start selection. An
  // exact source end remains representable as a clip end, including before gaps.
  const span=spans.find(s=>seconds>=s.start&&seconds<s.end)||spans.find(s=>Math.abs(seconds-s.end)<=EPSILON_SECONDS);
  return span?Math.round(span.wall+(Math.min(seconds,span.end)-span.start)*1000):null;
}
export function recordingTimeBounds(session,sources,duration=session?.duration) {
  const spans=spansFor(session,sources,duration);
  return spans.length?{min:Math.min(...spans.map(s=>s.wall)),max:Math.max(...spans.map(s=>s.wall+(s.end-s.start)*1000))}:null;
}
export function positionAtRecordingTime(epochMs,session,sources,duration=session?.duration) {
  if(!Number.isFinite(epochMs))throw new Error(INVALID_INPUT);
  const spans=spansFor(session,sources,duration),bounds=recordingTimeBounds(session,sources,duration);
  if(!bounds)throw new Error('素材还没有可定位的录制内容，请使用视频时间定位。');
  if(epochMs<bounds.min-.001)throw new Error('这个时间早于已录制内容的开始时间。');
  if(epochMs>bounds.max+.001)throw new Error(session?.status==='recording'||session?.status==='waiting'||session?.status==='finishing'?'这个时间尚未录制，请选择已录制的时间。':'这个时间晚于已录制内容的结束时间。');
  const candidates=spans.flatMap(span=>{
    const seconds=span.start+(epochMs-span.wall)/1000;
    return seconds>=span.start-EPSILON_SECONDS&&seconds<=span.end+EPSILON_SECONDS?[Math.max(span.start,Math.min(span.end,seconds))]:[];
  });
  if(!candidates.length)throw new Error('这个时间处于断流或未录制的间隙，请选择已有画面的时间。');
  if(candidates.some(seconds=>Math.abs(seconds-candidates[0])>EPSILON_SECONDS))throw new Error('这个录制时间对应多个视频位置，请切换到视频时间定位。');
  return candidates[0];
}
