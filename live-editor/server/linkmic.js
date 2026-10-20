import fs from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { linkmicSei } from './linkmic-sei.js';
import { labelGeometry } from '../shared/linkmic-labels.js';
import { LinkmicAvatars } from './linkmic-avatars.js';

const VERSION=3,TTL=6;
const stamp=tag=>(tag.readUIntBE(4,3)+tag[7]*16777216)/1000;
export class LinkmicIndex {
  constructor(store,{resolver,ffmpeg,avatars}={}) {
    this.store=store;this.resolver=resolver;this.requested=new Set();this.pending=new Map();this.refreshes=new Map();this.retry=new Map();this.historyCursor=0;this.closed=false;this.abort=new AbortController();
    this.avatars=avatars||new LinkmicAvatars(store,{ffmpeg});
  }
  request(id){this.requested.delete(id);this.requested.add(id);while(this.requested.size>16)this.requested.delete(this.requested.values().next().value);}
  async tick(sources) {
    const active=new Set(sources.filter(s=>s.closed===0).map(s=>s.id));
    for(const key of this.retry.keys())if(!active.has(key.split(':')[0]))this.retry.delete(key);
    // Keep current recordings prompt and rotate one old source per tick so
    // selecting a long archive cannot monopolize the ingestion loop.
    const history=sources.filter(s=>s.closed===2&&this.requested.has(s.session));
    const selected=sources.filter(s=>s.closed<2);
    if(history.length)selected.push(history[this.historyCursor++%history.length]);
    for(const source of selected){
      if(this.closed)break;
      await this.scan(source).catch(error=>this.store.diagnostics?.record('连麦名牌索引',error,{level:'警告'}));
    }
  }
  async ensure(id) {
    this.request(id);
    for(const source of this.store.sources(id)) {
      let more=true;
      while(more&&!this.closed){more=await this.scan(source);if(more)await yieldTurn();}
    }
  }
  scan(source) {
    if(this.pending.has(source.id))return this.pending.get(source.id);
    const operation=this.read(source).finally(()=>this.pending.delete(source.id));
    this.pending.set(source.id,operation);return operation;
  }
  async read(source) {
    if(this.closed||!this.store.session(source.session))return false;
    let progress=this.store.setting('linkmic-index:'+source.id)||{version:VERSION,pos:13,seq:0,lengthSize:4,mode:'original'};
    if(progress.version!==VERSION){
      // A newly supported layout must replace old empty frames, including
      // timestamps that were previously stored separately.
      this.store.run('DELETE FROM linkmic_frames WHERE source=?',source.id);
      progress={version:VERSION,pos:13,seq:0,lengthSize:4,mode:'original'};
    }
    if(progress.complete&&source.closed===2)return false;
    let bytes,more=false;
    if(progress.mode==='original'){
      let file;
      try {
        file=await fs.open(source.path,'r');const stat=await file.stat();
        if(progress.pos>=stat.size){if(source.closed===2){progress.complete=true;this.store.setting('linkmic-index:'+source.id,progress);}return false;}
        if(progress.pos===13){const header=Buffer.alloc(13);await file.read(header,0,13,0);if(header.toString('ascii',0,3)!=='FLV'||header.readUInt32BE(5)!==9)return false;}
        bytes=Buffer.alloc(Math.min(20*1024*1024,stat.size-progress.pos));
        const read=await file.read(bytes,0,bytes.length,progress.pos);bytes=bytes.subarray(0,read.bytesRead);more=progress.pos+bytes.length<stat.size;
      }catch(error){
        if(error.code!=='ENOENT')throw error;
        progress={version:VERSION,pos:0,seq:0,lengthSize:4,mode:'chunks'};bytes=Buffer.alloc(0);
        // A retained original is optional. Compacted materials can still use
        // their indexed media chunks, which contain the same SEI NAL units.
      }finally{await file?.close();}
    }
    if(progress.mode==='chunks') {
      const header=JSON.parse(source.header||'{}');
      if(header.video){const tag=Buffer.from(header.video,'base64');if(tag.length>20)progress.lengthSize=(tag[20]&3)+1;}
      const chunk=this.store.get('SELECT * FROM chunks WHERE source=? AND seq>=? ORDER BY seq LIMIT 1',source.id,progress.seq);
      if(!chunk){if(source.closed===2){progress.complete=true;this.store.setting('linkmic-index:'+source.id,progress);}return false;}
      bytes=await fs.readFile(chunk.path);progress.seq=chunk.seq+1;more=true;
    }
    const frames=[];let consumed=0;
    while(consumed+15<=bytes.length) {
      const length=bytes.readUIntBE(consumed+1,3)+15;
      if(length>16*1024*1024)break;
      if(consumed+length>bytes.length)break;
      const tag=bytes.subarray(consumed,consumed+length);consumed+=length;
      if(tag.readUInt32BE(length-4)!==length-4)break;
      if(tag[0]!==9||tag.length<20)continue;
      if(tag[12]===0&&tag.length>20){progress.lengthSize=(tag[20]&3)+1;continue;}
      const composition=tag.readIntBE(13,3)/1000,time=Math.max(source.start,source.start+stamp(tag)+composition);
      for(const data of linkmicSei(tag,progress.lengthSize))frames.push({time,data});
    }
    if(progress.mode==='original')progress.pos+=consumed;
    if(this.closed||!this.store.session(source.session))return false;
    this.store.transaction(()=>{
      for(const {time,data} of frames) {
        const signature=JSON.stringify(data);
        if(progress.signature===signature&&time>=progress.seen&&time-progress.seen<=TTL)
          this.store.run('UPDATE linkmic_frames SET end=? WHERE source=? AND time=?',time+TTL,source.id,progress.active);
        else {
          if(Number.isFinite(progress.active))this.store.run('UPDATE linkmic_frames SET end=MIN(end,?) WHERE source=? AND time=?',time,source.id,progress.active);
          this.store.run('INSERT OR REPLACE INTO linkmic_frames(source,time,end,data) VALUES(?,?,?,?)',source.id,time,time+TTL,signature);
          progress.active=time;progress.signature=signature;
        }
        progress.seen=time;
      }
      this.store.setting('linkmic-index:'+source.id,progress);
    });
    const frame=frames.at(-1)?.data;
    if(frame?.platform==='douyin'&&frame.channel&&source.closed===0)this.refreshPeople(source,frame);
    return consumed>0&&more;
  }
  refreshPeople(source,frame) {
    const key=source.id+':'+frame.channel;
    if(this.closed||!this.resolver?.linkmic||this.refreshes.has(key)||(this.retry.get(key)||0)>Date.now())return;
    const owner=this.store.setting('linkmic-owner:'+source.id);
    if(!owner?.roomId||!owner?.id)return;
    this.retry.set(key,Date.now()+15000);
    const operation=this.resolver.linkmic({roomId:owner.roomId,anchorId:owner.id,channel:frame.channel,version:frame.version,signal:this.abort.signal})
      .then(async people=>{
        if(this.closed||!this.store.session(source.session))return;
        this.store.transaction(()=>{for(const person of people)this.store.run(
          `INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?) ON CONFLICT(source,channel,link_id) DO UPDATE SET
          avatar=CASE WHEN id=excluded.id THEN avatar ELSE '' END,avatar_key=CASE WHEN id=excluded.id THEN avatar_key ELSE '' END,id=excluded.id,name=excluded.name`,
          source.id,frame.channel,person.linkId,person.id,person.name);});
        for(const person of people.filter(p=>frame.participants.some(seat=>seat.audioOnly&&seat.linkId===p.linkId))) {
          if(this.closed)break;
          await this.avatars.capture(source,frame.channel,person,this.abort.signal).catch(()=>{});
        }
      }).catch(()=>{/* Retry independently; a roster outage must not stop video. */})
      .finally(()=>this.refreshes.delete(key));
    this.refreshes.set(key,operation);
  }
  events(id,from=0,to=Infinity) {
    const sources=new Map(this.store.sources(id).map(source=>[source.id,source]));
    const people=new Map(this.store.all('SELECT p.* FROM linkmic_people p JOIN sources s ON s.id=p.source WHERE s.session=?',id).map(p=>[p.source+':'+p.channel+':'+p.link_id,p]));
    return this.store.all('SELECT f.* FROM linkmic_frames f JOIN sources s ON s.id=f.source WHERE s.session=? AND f.time<? AND f.end>? ORDER BY f.time',id,to,from).map(row=>{
      const source=sources.get(row.source),frame=JSON.parse(row.data),owner=this.store.setting('linkmic-owner:'+row.source);
      const participants=frame.participants.map(person=>{
        const found=people.get(row.source+':'+frame.channel+':'+person.linkId);
        return {...person,...(found?{id:found.id,name:found.name,...(found.avatar?{avatar:found.avatar,avatarUrl:`/api/sessions/${id}/linkmic-avatars/${row.source}/${found.avatar}.png`}:{})}:person.owner&&owner?{id:owner.id,name:owner.name}:{})};
      });
      return {source:row.source,time:row.time,end:Math.min(row.end,source.start+source.duration),participants};
    }).filter(event=>event.end>event.time);
  }
  async close(){this.closed=true;this.abort.abort();await Promise.allSettled([...this.pending.values(),...this.refreshes.values()]);}
}

function assTime(time) {
  const cs=Math.max(0,Math.round(time*100)),s=Math.floor(cs/100);
  return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;
}
const assEscape=text=>text.replace(/\\/g,'＼').replace(/{/g,'｛').replace(/}/g,'｝').replace(/\r|\n/g,' ');
export function linkmicAss(events,width,height,{base=0,from=0,to=Infinity,sourceWidth=width,sourceHeight=height}={}) {
  const lines=[];
  for(const event of events) {
    const start=Math.max(from,event.time),end=Math.min(to,event.end);
    if(end<=start)continue;
    for(const person of event.participants) {
      const g=labelGeometry(person,width,height,sourceWidth,sourceHeight);
      if(!g?.text)continue;
      lines.push(`Dialogue: 2,${assTime(start-base)},${assTime(end-base)},Anchor,,0,0,0,,{\\an3\\pos(${g.x.toFixed(2)},${g.y.toFixed(2)})\\fs${g.size.toFixed(2)}\\clip(${Math.ceil(g.left)},${Math.ceil(g.top)},${Math.floor(g.right)},${Math.floor(g.bottom)})}${assEscape(g.text)}\n`);
    }
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Anchor,Microsoft YaHei,16,&H00FFFFFF,&H00FFFFFF,&H80000000,&H90000000,0,0,0,0,100,100,0,0,1,1,1,3,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`+lines.join('');
}
