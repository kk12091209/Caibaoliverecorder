import {createHash} from 'node:crypto';
import {giftEligible,normalizedGiftStyle,giftDescription,giftGeometry,GIFT_SECONDS} from '../shared/gifts.js';
import {isGiftEvent} from '../shared/lottery-records.js';

export function safeGiftIcon(value){
  try{const u=new URL(value);if(u.protocol==='http:')u.protocol='https:';
    return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&/^(?:[a-z0-9-]+\.)+(?:hdslb\.com|biliimg\.com|douyinpic\.com|byteimg\.com|pstatp\.com|douyincdn\.com)$/.test(u.hostname)?u.href:'';
  }catch{return '';}
}
export function installGifts(store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS gift_events(id TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,time REAL NOT NULL,platform TEXT NOT NULL,type TEXT NOT NULL,
    user TEXT NOT NULL,name TEXT NOT NULL,gift_id TEXT NOT NULL,count INTEGER NOT NULL,total_price REAL,currency TEXT NOT NULL,icon TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS gift_time ON gift_events(session,time);
  CREATE TABLE IF NOT EXISTS gift_icons(key TEXT PRIMARY KEY,png BLOB NOT NULL,updated INTEGER NOT NULL);
`);}
const amount=value=>value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1e12?Number(value):null;
export function giftFromXml(type,attributes,source,offset){
  const local=Number(attributes.ts),count=Number(attributes.giftcount??attributes.count??1);
  if(!['gift','guard'].includes(type)||!Number.isFinite(local)||local<0||local>366*86400||!Number.isSafeInteger(count)||count<1||count>1e9)return null;
  const platform=attributes.platform==='douyin'?'douyin':'bilibili';
  let name=attributes.giftname||({1:'总督',2:'提督',3:'舰长'}[attributes.level])||(type==='guard'?'上舰':'礼物');
  let totalPrice=amount(attributes.total_price);
  if(totalPrice===null){
    const total=amount(attributes.total_coin),unit=amount(attributes.unit_coin);
    if(platform==='douyin')totalPrice=total??(unit===null?null:unit*count);
    else if(attributes.coin_type==='silver')totalPrice=0;
    else if(attributes.coin_type==='gold')totalPrice=total!==null?total/1000:unit!==null?unit*count/1000:null;
  }
  if(totalPrice!==null&&(!Number.isFinite(totalPrice)||totalPrice>1e12))totalPrice=null;
  const stable=/^[\w:-]{1,160}$/.test(attributes.eventid||'')?attributes.eventid:offset;
  return {id:createHash('sha256').update(`${source.id}:gift:${stable}`).digest('hex').slice(0,32),session:source.session,source:source.id,
    time:source.start+local,platform,type,user:String(attributes.user||'观众').slice(0,200),name:String(name).slice(0,200),
    giftId:String(attributes.giftid||'').slice(0,80),count,totalPrice,currency:platform==='douyin'?'douyin_coin':'CNY',icon:safeGiftIcon(attributes.icon)};
}
export function saveGift(store,g){
  return store.run(`INSERT INTO gift_events(id,session,source,time,platform,type,user,name,gift_id,count,total_price,currency,icon) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET count=MAX(gift_events.count,excluded.count),time=MIN(gift_events.time,excluded.time),
    total_price=CASE WHEN excluded.count>=gift_events.count THEN COALESCE(excluded.total_price,gift_events.total_price) ELSE gift_events.total_price END,
    icon=CASE WHEN excluded.icon!='' THEN excluded.icon ELSE gift_events.icon END`,g.id,g.session,g.source,g.time,g.platform,g.type,g.user,g.name,g.giftId,g.count,g.totalPrice,g.currency,g.icon).changes;
}
export function giftMessages(store,id,{from=0,to=Number.MAX_SAFE_INTEGER,search='',limit=500,style,at}={}){
  style=normalizedGiftStyle(style);
  const args=[id,from,to,`%${search}%`,`%${search}%`,style.minBilibili,style.minDouyin];
  const query=`SELECT id,session,source,time,platform,type,user,name,gift_id AS giftId,count,total_price AS totalPrice,currency,icon
    FROM gift_events WHERE session=? AND time>=? AND time<=? AND (name LIKE ? OR user LIKE ?)
    AND ((platform='bilibili' AND (?=0 OR total_price>=?)) OR (platform='douyin' AND (?=0 OR total_price>=?)))`;
  // Bind the same minimum twice without interpolating user input into SQL.
  args.splice(5,2,style.minBilibili,style.minBilibili,style.minDouyin*10,style.minDouyin*10);
  const rows=Number.isFinite(at)?store.all('SELECT * FROM ('+query+' ORDER BY ABS(time-?),time,id LIMIT ?) ORDER BY time,id',...args,at,limit):store.all(query+' ORDER BY time,id LIMIT ?',...args,limit);
  return rows.map(g=>({...g,text:giftDescription(g),color:'16766069',iconUrl:g.icon?`/api/gift-icons/${createHash('sha256').update(g.icon).digest('hex')}.png`:''}));
}
const assTime=t=>{t=Math.max(0,t);return `${Math.floor(t/3600)}:${String(Math.floor(t/60)%60).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;};
const escape=value=>String(value).replace(/[{}\\\r\n]/g,' ').slice(0,180);
export function giftSegments(events,from=0,to=Infinity){
  events=events.filter(isGiftEvent).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
  const cuts=[...new Set(events.flatMap(g=>[Math.max(from,g.time),Math.min(to,g.time+GIFT_SECONDS)]).filter(t=>t>=from&&t<=to))].sort((a,b)=>a-b);
  const segments=[];let cursor=0;
  for(let n=0;n<cuts.length-1;n++){
    const start=cuts[n],end=cuts[n+1];if(end<=start)continue;
    while(cursor<events.length&&events[cursor].time<=start)cursor++;
    segments.push({start,end,events:events.slice(Math.max(0,cursor-3),cursor).filter(g=>g.time+GIFT_SECONDS>start)});
  }
  return segments;
}
export function giftAss(events,width,height,{base=0,from=0,to=Infinity}={}){
  let result='';
  for(const {start,end,events:active} of giftSegments(events,from,to)){
    for(const [lane,g] of active.entries()){
      const box=giftGeometry(width,height,lane),p=`\\an7\\pos(${box.x.toFixed(1)},${box.y.toFixed(1)})`;
      result+=`Dialogue: 4,${assTime(start-base)},${assTime(end-base)},Default,,0,0,0,,{${p}\\p1\\bord0\\shad0\\1c&H352537&\\1a&H35&}m 0 0 l ${box.w.toFixed(1)} 0 l ${box.w.toFixed(1)} ${box.h.toFixed(1)} l 0 ${box.h.toFixed(1)}{\\p0}\n`;
      result+=`Dialogue: 5,${assTime(start-base)},${assTime(end-base)},Default,,0,0,0,,{\\an7\\pos(${(box.x+box.pad).toFixed(1)},${(box.y+box.pad).toFixed(1)})\\fs${(box.size*1.6).toFixed(1)}\\1a&H00&}礼\n`;
      result+=`Dialogue: 5,${assTime(start-base)},${assTime(end-base)},Default,,0,0,0,,{\\an7\\q2\\clip(${Math.round(box.x+box.pad+box.icon+box.pad)},${Math.round(box.y)},${Math.round(box.x+box.w-box.pad)},${Math.round(box.y+box.h)})\\pos(${(box.x+box.pad+box.icon+box.pad).toFixed(1)},${(box.y+box.pad).toFixed(1)})\\fs${box.size.toFixed(1)}\\1c&HFFFFFF&\\1a&H00&\\bord1}${escape(g.user)}\\N${escape(g.name)} × ${g.count} · ${escape(giftDescription(g).split(' · ').at(-1))}\n`;
    }
  }
  return result;
}
