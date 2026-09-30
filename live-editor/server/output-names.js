import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Recording clocks, rather than export time or the computer's timezone, name outputs.
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function stamp(milliseconds) {
  if (!Number.isFinite(milliseconds)) throw new Error('录像开始时间无效，无法按日期命名。');
  const p = Object.fromEntries(clock.formatToParts(new Date(milliseconds)).map(p => [p.type, p.value]));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}`;
}
function wallAt(session, sources, seconds, end = false) {
  const source = sources.find(s => end
    ? seconds > s.start && seconds <= s.start + s.duration + .001
    : seconds >= s.start && seconds < s.start + s.duration);
  const wall = source && Date.parse(source.wall);
  return Number.isFinite(wall) ? wall + (seconds - source.start) * 1000 : Date.parse(session.created) + seconds * 1000;
}
export function outputSpan(session, sources, ranges) {
  const spans = ranges?.length ? ranges : [{ start: sources[0]?.start || 0, end: Math.max(session.duration, ...sources.map(s => s.start + s.duration)) }];
  const start = Math.min(...spans.map(r => wallAt(session, sources, r.start)));
  const end = Math.max(...spans.map(r => wallAt(session, sources, r.end, true)));
  const first = stamp(start), last = stamp(end), date = first.slice(0, 8);
  return { date, stem: `${first}-${last.startsWith(date) ? last.slice(8) : last}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone: 'Asia/Shanghai' };
}
const suffixed = (stem, n) => n === 1 ? stem : `${stem}_${n}`;
export async function reserveClip(root, span) {
  const parent = path.join(root, span.date); await fs.mkdir(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const stem = suffixed(span.stem, n), dir = path.join(parent, stem);
    try { await fs.mkdir(dir); return { ...span, stem, dir, file: path.join(dir, `${stem}.mp4`) }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
export async function reserveFull(root,span,reservationRoot) {
  const dir=path.join(root,span.date);await fs.mkdir(dir,{recursive:true});await fs.mkdir(reservationRoot,{recursive:true});
  for(let n=1;;n++) {
    const stem=suffixed(span.stem,n),file=path.join(dir,stem+'.mp4');
    const identity=process.platform==='win32'?file.toLowerCase():file;
    const reservation=path.join(reservationRoot,'bili-full-'+createHash('sha256').update(identity).digest('hex'));
    try {await fs.mkdir(reservation);}catch(e){if(e.code==='EEXIST')continue;throw e;}
    try {
      const files=await fs.readdir(dir);
      if(files.includes(path.basename(file))||files.includes(path.basename(clipFile(file,'danmaku')))) {await fs.rmdir(reservation);continue;}
      return {...span,stem,dir,file,reservation};
    }catch(e){await fs.rmdir(reservation).catch(()=>{});throw e;}
  }
}
export function clipFile(file, kind) {
  if (kind === 'video') return file;
  const stem=clipStem(file);
  if (kind === 'danmaku') return path.join(path.dirname(file),'【弹幕版】'+stem+'.mp4');
  return path.join(path.dirname(file), kind === 'manifest' ? 'edit.json' : stem + '.' + kind);
}
function clipStem(file) {
  return path.parse(file).name.replace(/^(?:【弹幕版】)+/u,'').replace(/(?:_弹幕版)+$/u,'');
}
// Use the recorded output paths; downloadable sidecars are no longer produced.
export function exportedJobFile(job, kind) {
  if(kind==='video')return job.file||null;
  if(kind!=='danmaku'||!['dual','danmaku'].includes(job.mode))return null;
  let data=job.data;
  if(typeof data==='string'){try{data=JSON.parse(data);}catch{return null;}}
  return data?.output?.danmakuFile||(job.mode==='danmaku'?job.file:null)||null;
}
export function archiveFile(file, kind) {
  if (kind === 'video') return file;
  const { dir, name } = path.parse(file);
  // Keep downloads working for recordings made before date-based naming.
  return path.join(dir, name === 'full'
    ? (kind === 'xml' ? 'full-chat.xml' : 'originals.json')
    : name + (kind === 'xml' ? '.xml' : '.originals.json'));
}
