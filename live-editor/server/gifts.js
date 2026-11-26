import {cursorFilter} from './feed-cursor.js';
import {createHash} from 'node:crypto';
import {giftEligible,normalizedGiftStyle,giftDescription,giftGeometry,GIFT_SECONDS} from '../shared/gifts.js';
import {isGiftEvent} from '../shared/lottery-records.js';
import { MAX_GIFT_SECONDS } from '../shared/gift-layout.js';

export function safeGiftIcon(value){
  try{const u=new URL(value);if(u.protocol==='http:')u.protocol='https:';
    return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&/^(?:[a-z0-9-]+\.)+(?:hdslb\.com|biliimg\.com|douyinpic\.com|byteimg\.com|pstatp\.com|douyincdn\.com)$/.test(u.hostname)?u.href:'';
  }catch{return '';}
}
export function installGifts(store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS gift_events(id TEXT PRIMARY KEY,session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,time REAL NOT NULL,platform TEXT NOT NULL,type TEXT NOT NULL,
    user TEXT NOT NULL,name TEXT NOT NULL,gift_id TEXT NOT NULL,count INTEGER NOT NULL,total_price REAL,currency TEXT NOT NULL,icon TEXT NOT NULL DEFAULT '',comment TEXT NOT NULL DEFAULT '',sender_uid TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS gift_time ON gift_events(session,time);
  CREATE TABLE IF NOT EXISTS gift_updates(event TEXT NOT NULL REFERENCES gift_events(id) ON DELETE CASCADE,
    time REAL NOT NULL,count INTEGER NOT NULL, PRIMARY KEY(event,time,count));
  CREATE TABLE IF NOT EXISTS super_chat_retractions(session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    platform_id TEXT NOT NULL, PRIMARY KEY(session,platform_id));
  CREATE TABLE IF NOT EXISTS gift_icons(key TEXT PRIMARY KEY,png BLOB NOT NULL,updated INTEGER NOT NULL);
`);
  const columns=new Set(store.all('PRAGMA table_info(gift_events)').map(column=>column.name));
  for(const name of ['comment','sender_uid','presentation']){
    if(!columns.has(name))store.db.exec(`ALTER TABLE gift_events ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  }
}
const amount=value=>value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1e12?Number(value):null;
export function giftEventId(type,attributes,source,offset){
  const stable=/^[\w:-]{1,160}$/.test(attributes.eventid||'')?attributes.eventid:offset;
  return createHash('sha256').update(`${source.id}:${type==='sc'?'sc':'gift'}:${stable}`).digest('hex').slice(0,32);
}
export function giftSenderId(attributes){
  // Earlier Douyin recordings retain the sender in the combo ID only.
  const uid=attributes.platform==='douyin'
    ?attributes.sender_id||/^combo:([1-9]\d{0,30}):\d+:\d+$/.exec(attributes.eventid||'')?.[1]
    :attributes.uid;
  return /^[1-9]\d{0,30}$/.test(uid||'')?uid:'';
}
export const superChatId=value=>/^[1-9]\d{0,29}$/.test(String(value??''))?String(value):'';
const validColor=value=>/^#[a-f0-9]{6}$/i.test(value||'')?value:'';

export function superChatPresentation(attributes) {
  let raw;
  if (attributes.raw?.length < 64*1024) try {raw=JSON.parse(attributes.raw);} catch {}
  const duration = amount(attributes.time);
  return {platformId:superChatId(attributes.scid||raw?.id),platformSeconds:duration>0?duration:undefined,
    headColor:validColor(attributes.headcolor||raw?.background_top_color),
    bodyColor:validColor(attributes.bodycolor||raw?.background_bottom_color||raw?.background_color)};
}

export function giftFromXml(type,attributes,source,offset,comment=''){
  const local=Number(attributes.ts),sc=type==='sc',count=sc?1:Number(attributes.giftcount??attributes.count??1);
  if(!['gift','guard','sc'].includes(type)||!Number.isFinite(local)||local<0||local>366*86400||!Number.isSafeInteger(count)||count<1||count>1e9)return null;
  const platform=!sc&&attributes.platform==='douyin'?'douyin':'bilibili';
  const name=sc?'醒目留言':attributes.giftname||({1:'总督',2:'提督',3:'舰长'}[attributes.level])||(type==='guard'?'上舰':'礼物');
  let totalPrice=amount(sc?attributes.price:attributes.total_price);
  if(!sc&&totalPrice===null){
    const total=amount(attributes.total_coin),unit=amount(attributes.unit_coin);
    if(platform==='douyin')totalPrice=total??(unit===null?null:unit*count);
    else if(attributes.coin_type==='silver')totalPrice=0;
    else if(attributes.coin_type==='gold')totalPrice=total!==null?total/1000:unit!==null?unit*count/1000:null;
  }
  if(totalPrice!==null&&(!Number.isFinite(totalPrice)||totalPrice>1e12))totalPrice=null;
  return {id:giftEventId(type,attributes,source,offset),session:source.session,source:source.id,senderId:giftSenderId(attributes),
    time:source.start+local,platform,type,user:String(attributes.user||'观众').slice(0,200),name:String(name).slice(0,200),
    giftId:String(attributes.giftid||'').slice(0,80),count,totalPrice,currency:platform==='douyin'?'douyin_coin':'CNY',icon:safeGiftIcon(attributes.icon),...(sc?{comment:String(comment).slice(0,10000), presentation:superChatPresentation(attributes)}:{}),
    updateTime: /^combo:/.test(attributes.eventid||'') && amount(attributes.update_at)!==null &&
      Number(attributes.update_at)>=local && Number(attributes.update_at)<=366*86400 ? source.start+Number(attributes.update_at) : undefined};
}
export function saveGift(store,g){
  const result=store.run(`INSERT INTO gift_events(id,session,source,time,platform,type,user,name,gift_id,count,total_price,currency,icon,comment,sender_uid,presentation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET count=MAX(gift_events.count,excluded.count),time=MIN(gift_events.time,excluded.time),
    total_price=CASE WHEN excluded.count>=gift_events.count THEN COALESCE(excluded.total_price,gift_events.total_price) ELSE gift_events.total_price END,
    icon=CASE WHEN excluded.icon!='' THEN excluded.icon ELSE gift_events.icon END,
    sender_uid=CASE WHEN gift_events.sender_uid='' THEN excluded.sender_uid ELSE gift_events.sender_uid END,
    presentation=CASE WHEN excluded.presentation<>'' THEN excluded.presentation ELSE gift_events.presentation END`,
    g.id,g.session,g.source,g.time,g.platform,g.type,g.user,g.name,g.giftId,g.count,g.totalPrice,g.currency,g.icon,g.comment??'',g.senderId||'',g.presentation?JSON.stringify(g.presentation):'');
  if (Number.isFinite(g.updateTime)) store.run('INSERT OR IGNORE INTO gift_updates VALUES(?,?,?)',g.id,g.updateTime,g.count);
  return result.changes;
}
export function giftMessages(store,id,{from=0,to=Number.MAX_SAFE_INTEGER,search='',limit=500,style,at,page,includeSuperChat=false,overlay=false,includeGifts=true,maxUpdateTime=to}={}){
  style=normalizedGiftStyle(style);
  const pattern=`%${search}%`,args=[id,from,to,pattern,pattern];
  const commentMatch=includeSuperChat?" OR (type='sc' AND comment LIKE ?)":"";
  if(commentMatch)args.push(pattern);
  const uidMatch=includeSuperChat&&/^[1-9]\d{0,30}$/.test(search)?' OR sender_uid=?':'';
  if(uidMatch)args.push(search);
  if (overlay) args.push(style.minSuperChat,style.minSuperChat);
  args.push(style.minBilibili,style.minBilibili,style.minDouyin*10,style.minDouyin*10);
  if (overlay) args.unshift(maxUpdateTime);
  const query=`SELECT id,session,source,time,platform,type,user,name,gift_id AS giftId,count,total_price AS totalPrice,currency,icon,comment${overlay?`,presentation,(SELECT json_group_array(json_object('time',time,'count',count)) FROM
      (SELECT time,count FROM gift_updates WHERE event=gift_events.id AND time<=? ORDER BY time,count)) AS updates`:''}
    FROM gift_events WHERE session=? AND time>=? AND time<=? AND (name LIKE ? OR user LIKE ?${commentMatch}${uidMatch})
    ${includeSuperChat?"":"AND type<>'sc'"}${includeGifts?"":" AND type='sc'"}
    ${overlay?`AND (type<>'sc' OR NOT EXISTS(SELECT 1 FROM super_chat_retractions r
      WHERE r.session=gift_events.session AND r.platform_id=json_extract(NULLIF(gift_events.presentation,''),'$.platformId')))`:''}
    AND (${overlay?"(type='sc' AND (?=0 OR total_price>=?)) OR (type<>'sc' AND (":" "}
    (platform='bilibili' AND (?=0 OR total_price>=?)) OR (platform='douyin' AND (?=0 OR total_price>=?))${overlay?"))":""})`;
  const paged=query+cursorFilter('g',page,args);
  const rows=page?store.all(paged+` ORDER BY time ${page.direction==='before'?'DESC':'ASC'},id ${page.direction==='before'?'DESC':'ASC'} LIMIT ?`,...args,limit):Number.isFinite(at)?store.all('SELECT * FROM ('+query+' ORDER BY ABS(time-?),time,id LIMIT ?) ORDER BY time,id',...args,at,limit):store.all(query+' ORDER BY time,id LIMIT ?',...args,limit);
  return rows.map(({comment,presentation,updates,...g})=>{
    const metadata=overlay&&presentation?JSON.parse(presentation):{};
    const sequence=updates?JSON.parse(updates):[];
    let count=g.count;
    if (sequence[0]?.time===g.time) count=sequence[0].count;
    const increments=[];
    for (const point of sequence) {
      if (point.time>=g.time && point.count>count) {count=point.count;increments.push(point);}
    }
    return {...g,count:overlay&&sequence[0]?.time===g.time?sequence[0].count:g.count,...metadata,
      ...(increments.length?{updates:increments}:{}),text:g.type==='sc'?comment:giftDescription(g),color:'16766069',
      iconUrl:g.icon?`/api/gift-icons/${createHash('sha256').update(g.icon).digest('hex')}.png`:''};
  });
}
export function retractSuperChat(store,session,value) {
  const id=superChatId(value);
  if (id) store.run('INSERT OR IGNORE INTO super_chat_retractions VALUES(?,?)',session,id);
}

export function giftHistoryStart(store,id,from) {
  if (from<=MAX_GIFT_SECONDS) return 0;
  const result=store.get(`WITH events(t) AS (
    SELECT time FROM gift_events WHERE session=? AND time<=?
    UNION SELECT u.time FROM gift_updates u JOIN gift_events g ON g.id=u.event WHERE g.session=? AND u.time<=?
  ), gaps AS (SELECT t,LAG(t,1,0) OVER (ORDER BY t) AS previous FROM events)
  SELECT CASE WHEN ?-max(t)>? THEN ? ELSE (SELECT max(t) FROM gaps WHERE t-previous>?) END AS start FROM events`,
    id,from,id,from,from,MAX_GIFT_SECONDS,from,MAX_GIFT_SECONDS);
  return result?.start??0;
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
