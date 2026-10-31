import {createHash} from 'node:crypto';
import {LOTTERY_USER,validateLotteryNote} from '../shared/lottery-records.js';

export function installLotteryRecords(store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS lottery_records(id TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    activity TEXT NOT NULL,room INTEGER NOT NULL,time REAL NOT NULL,first_seen INTEGER NOT NULL,draw_at INTEGER,result_seen INTEGER,
    time_kind TEXT NOT NULL,phrase TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,expected INTEGER,participants INTEGER NOT NULL DEFAULT 0,winners TEXT NOT NULL DEFAULT '[]',last_live INTEGER NOT NULL,
    UNIQUE(session,activity));
  CREATE INDEX IF NOT EXISTS lottery_time ON lottery_records(session,time);
`);}
const safeText=(value,limit)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit):'';
const numericId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)?value:Number.isSafeInteger(value)&&value>0?String(value):null;
const seconds=value=>Number.isSafeInteger(value)&&value>=1000000000&&value<=9999999999?value:null;

export function normalizeLottery(data,room,now=Date.now()){
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('天选活动信息格式无效。');
  if(!data.id)return null;
  const activity=numericId(data.id);
  if(!activity||Number(data.room_id)!==room||![0,1,2].includes(data.lot_status))throw new Error('天选活动与直播间不匹配。');
  const current=seconds(data.current_time),remaining=data.time;
  if(!current||!Number.isSafeInteger(remaining)||remaining<0||remaining>86400||Math.abs(current*1000-now)>86400000)throw new Error('天选活动时间无效。');
  const phrases=Array.isArray(data.danmu_new)?data.danmu_new.map(x=>safeText(x?.danmu,500)).filter(Boolean):[];
  const phrase=phrases.join(' / ').slice(0,500)||safeText(data.danmu,500);
  const supplied=Array.isArray(data.award_users)?data.award_users:[],winners=[],seen=new Set();let truncated=supplied.length>5000;
  for(const [index,user] of supplied.slice(0,5000).entries()){
    if(!user||typeof user!=='object')continue;
    const mystery=user.is_mystery===true||user.isMystery===true||user.uinfo?.base?.is_mystery===true;
    const uid=mystery?'':numericId(user.uinfo?.uid??user.uid)||'';
    const name=mystery?'神秘用户':safeText(user.uinfo?.base?.name||user.uname||user.name,200)||'平台未返回昵称';
    const key=uid||'anonymous:'+index;if(seen.has(key))continue;seen.add(key);winners.push({uid,name,mystery});
  }
  const units=data.award_num,perPerson=data.award_per_capita??1;
  const expected=Number.isSafeInteger(units)&&units>0&&Number.isSafeInteger(perPerson)&&perPerson>0&&units%perPerson===0?units/perPerson:null;
  const state=data.lot_status===2?(!truncated&&expected!==null&&winners.length===expected?'complete':'partial'):data.lot_status===1||remaining===0?'settling':'ongoing';
  return {activity,phrase,state,expected,participants:Number.isSafeInteger(data.join_total)&&data.join_total>=0?data.join_total:0,winners,
    drawAt:data.lot_status===0&&remaining>0?(current+remaining)*1000:null,resultSeen:data.lot_status===2?now:null};
}

export function lotteryPosition(store,session,wall){
  const sources=store.sources(session.id).filter(s=>Number.isFinite(Date.parse(s.wall))).sort((a,b)=>Date.parse(a.wall)-Date.parse(b.wall));
  const source=sources.findLast(s=>Date.parse(s.wall)<=wall)||sources[0];
  return Math.max(0,source?source.start+(wall-Date.parse(source.wall))/1000:(wall-Date.parse(session.created))/1000);
}
export function saveLotteryObservation(store,session,data,now=Date.now(),{live=true}={}){
  if(!store.session(session.id))return null;
  const value=normalizeLottery(data,session.room,now);if(!value)return null;
  const id=createHash('sha256').update(`${session.id}:anchor-lottery:${value.activity}`).digest('hex').slice(0,32),old=store.get('SELECT * FROM lottery_records WHERE id=?',id);
  const drawAt=old?.draw_at??value.drawAt,resultSeen=old?.result_seen??value.resultSeen;
  const winners=old&&JSON.parse(old.winners).length>value.winners.length?JSON.parse(old.winners):value.winners;
  const expected=value.expected??old?.expected??null;
  const state=resultSeen!==null?(expected!==null&&winners.length===expected&&(value.state==='complete'||old?.state==='complete')?'complete':'partial'):value.state;
  const time=old?.time??lotteryPosition(store,session,drawAt??now),timeKind=old?.time_kind??(drawAt!==null?'planned':'observed');
  store.run(`INSERT INTO lottery_records(id,session,activity,room,time,first_seen,draw_at,result_seen,time_kind,phrase,state,expected,participants,winners,last_live)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET draw_at=excluded.draw_at,result_seen=excluded.result_seen,
    phrase=CASE WHEN excluded.phrase!='' THEN excluded.phrase ELSE lottery_records.phrase END,state=excluded.state,expected=excluded.expected,
    participants=MAX(lottery_records.participants,excluded.participants),winners=excluded.winners,last_live=excluded.last_live`,
    id,session.id,value.activity,session.room,time,old?.first_seen??now,drawAt,resultSeen,timeKind,value.phrase,state,expected,value.participants,JSON.stringify(winners),live?now:old?.last_live??now);
  return lotteryRecord(store,session.id,id);
}
const publicRecord=row=>row&&({id:row.id,session:row.session,type:'lottery',user:LOTTERY_USER,time:row.time,activity:row.activity,room:row.room,
  phrase:row.phrase,note:row.note,text:row.note||row.phrase||'天选开奖',revision:row.revision,state:row.state,expectedWinners:row.expected,
  winners:JSON.parse(row.winners),winnerCount:JSON.parse(row.winners).length,participants:row.participants,timeKind:row.time_kind,exportable:false});
export function lotteryRecord(store,session,id){return publicRecord(store.get('SELECT * FROM lottery_records WHERE session=? AND id=?',session,id));}
export function lotteryMessages(store,session,{from=0,to=Number.MAX_SAFE_INTEGER,search='',limit=500,at}={}){
  const args=[session,from,to,`%${search}%`,`%${search}%`];
  const query="SELECT * FROM lottery_records WHERE session=? AND time>=? AND time<=? AND state!='ongoing' AND (CASE WHEN note!='' THEN note ELSE phrase END LIKE ? OR '天选时刻' LIKE ?)";
  const rows=Number.isFinite(at)?store.all('SELECT * FROM ('+query+' ORDER BY ABS(time-?),time,id LIMIT ?) ORDER BY time,id',...args,at,limit):store.all(query+' ORDER BY time,id LIMIT ?',...args,limit);
  return rows.map(row=>{const {winners,...summary}=publicRecord(row);return summary;});
}
export function saveLotteryNote(store,session,id,input){
  const record=lotteryRecord(store,session,id);if(!record)throw Object.assign(new Error('天选记录不存在。'),{status:404});
  const value=validateLotteryNote(input);
  if(value.revision!==record.revision)throw Object.assign(new Error('这条备注已被另一窗口修改，请重新打开。'),{status:409});
  store.run('UPDATE lottery_records SET note=?,revision=revision+1 WHERE session=? AND id=?',value.note,session,id);
  return lotteryRecord(store,session,id);
}

export class LotteryRecorder{
  constructor(store,{request=fetch,now=Date.now,intervalMs=15000,timeoutMs=10000}={}){Object.assign(this,{store,request,now,intervalMs,timeoutMs});this.next=new Map();this.failures=new Map();this.running=null;this.closed=false;this.controller=new AbortController();}
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref?.();void this.tick();}
  tick(){if(this.closed)return Promise.resolve();return this.running??=(this.collect().finally(()=>{this.running=null;}));}
  async collect(){
    const now=this.now(),sessions=this.store.all(`SELECT DISTINCT s.* FROM sessions s LEFT JOIN lottery_records l ON l.session=s.id
      WHERE s.deleted_at='' AND s.room>0 AND (s.status IN ('recording','waiting') OR
      (s.status IN ('finishing','finished') AND l.state IN ('ongoing','settling','partial') AND l.last_live>=? AND l.time<=s.duration+5)) ORDER BY s.created DESC`,now-90000);
    const rooms=new Set(),due=[];
    for(const session of sessions){if(rooms.has(session.room)||this.store.setting('douyin-session:'+session.id)||!this.store.sources(session.id).length)continue;rooms.add(session.room);
      if((this.next.get(session.room)||0)<=now)due.push(session);}
    for(const room of this.next.keys())if(!rooms.has(room)){this.next.delete(room);this.failures.delete(room);}
    await Promise.allSettled(due.slice(0,2).map(async session=>{
      this.next.set(session.room,now+this.intervalMs);
      try{
        const data=await this.check(session.room);if(this.closed)return;
        const current=this.store.session(session.id);if(!current)return;
        const record=saveLotteryObservation(this.store,current,data,this.now(),{live:['recording','waiting'].includes(current.status)});
        this.failures.delete(session.room);
        if(record?.state==='ongoing'&&Number.isSafeInteger(data.time))this.next.set(session.room,this.now()+Math.min(this.intervalMs,Math.max(2000,data.time*1000+500)));
        if(record?.state==='settling'||record?.state==='partial')this.next.set(session.room,this.now()+3000);
      }catch(error){if(this.closed)return;const count=(this.failures.get(session.room)||0)+1;this.failures.set(session.room,count);this.next.set(session.room,this.now()+Math.min(300000,15000*2**Math.min(count,5)));
        if(count===1)this.store.diagnostics?.record('天选记录',`房间 ${session.room} 暂未取到活动信息，将稍后重试。`,{level:'警告'});}
    }));
  }
  async check(room){
    if(!Number.isSafeInteger(room)||room<=0||room>2147483647)throw new Error('直播间编号无效。');
    const response=await this.request(`https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Check?roomid=${room}`,{
      method:'GET',credentials:'omit',redirect:'error',headers:{'User-Agent':'Mozilla/5.0','Referer':`https://live.bilibili.com/${room}`},
      signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.timeoutMs)])});
    if(!response.ok){await response.body?.cancel();throw new Error('天选活动暂时无法读取。');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw new Error('天选活动信息过大。');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(result.code!==0)throw new Error('平台暂未提供天选活动。');return result.data||{};
  }
  async close(){this.closed=true;clearInterval(this.timer);this.controller.abort();await this.running;}
}
