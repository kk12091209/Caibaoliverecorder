import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {createApp} from '../server/index.js';
import {giftFromXml,saveGift,giftMessages,giftSegments,giftAss,safeGiftIcon} from '../server/gifts.js';
import {DEFAULT_GIFT_STYLE,validateGiftStyle,giftCards,giftPrice} from '../shared/gifts.js';
import {GiftIntake} from '../server/gift-intake.js';
import {decodeGift,decodePushFrame} from '../server/douyin-protocol.js';
import {chatXml} from '../server/douyin-recorder.js';
import {GiftIcons,giftIconKey} from '../server/gift-icons.js';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-gifts-')),store=new Store(root),session=store.createSession({status:'finished'}),source=store.addSource(session.id,path.join(root,'one.flv'),20);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});return {root,store,session,source};}
test('gift controls default off; both platform thresholds use yuan and invalid values fail',()=>{
 assert.deepEqual(DEFAULT_GIFT_STYLE,{preview:false,export:false,minBilibili:0,minDouyin:0,currency:'CNY'});
 for(const value of [{},null,{...DEFAULT_GIFT_STYLE,preview:'true'},{...DEFAULT_GIFT_STYLE,minBilibili:-1},{...DEFAULT_GIFT_STYLE,minDouyin:Infinity},{...DEFAULT_GIFT_STYLE,room:1}])assert.throws(()=>validateGiftStyle(value));
 assert.equal(giftPrice({platform:'bilibili',totalPrice:null}),'金额未知');
});
test('Bili paid/free/guard events retain exact amounts, separate from chat and density',async t=>{
 const {store,source,session}=await fixture(t);
 const g=giftFromXml('gift',{ts:'3',user:'测试',giftname:'小花',giftcount:'2',coin_type:'gold',unit_coin:'1000'},source,10);
 assert.equal(g.time,23);assert.equal(g.totalPrice,2);saveGift(store,g);
 saveGift(store,giftFromXml('guard',{ts:'6',level:'3',giftcount:'1',total_coin:'138000',coin_type:'gold'},source,20));
 saveGift(store,giftFromXml('gift',{ts:'8',giftname:'银瓜子',coin_type:'silver',unit_coin:'1000'},source,30));
 saveGift(store,giftFromXml('gift',{ts:'9',giftname:'旧礼物'},source,40));
 assert.equal(store.messages(session.id).length,0);assert.equal(store.get('SELECT COUNT(*) AS n FROM danmaku_density').n,0);
 const filtered=giftMessages(store,session.id,{style:{...DEFAULT_GIFT_STYLE,minBilibili:3}});
 assert.equal(filtered.length,1);assert.equal(filtered[0].name,'舰长');assert.equal(filtered[0].totalPrice,138);
 assert.equal(giftMessages(store,session.id,{style:DEFAULT_GIFT_STYLE}).length,4);
 assert.equal(giftFromXml('gift',{ts:'NaN'},source,50),null);
});
test('incremental gift XML survives partial writes without rewinding chat cursors or duplicating combo totals',async t=>{
 const {store,source,session}=await fixture(t),ingest=new Ingestor(store);
 const gift=count=>({id:'combo:one',time:2,user:'送礼观众',name:'玫瑰',giftId:'1',count,totalPrice:count*2,icon:'',platform:'douyin'});
 await fs.writeFile(source.xml,'<i>'+chatXml({messages:[],density:[],gifts:[gift(2)]})+'<gift ts="5"');
 await ingest.readDanmaku(source);assert.equal(giftMessages(store,session.id)[0].count,2);
 await fs.appendFile(source.xml,' giftname="未完"/>'+chatXml({messages:[],density:[],gifts:[gift(5),gift(3)]})+'</i>');
 await ingest.readDanmaku(source);await ingest.readDanmaku(source);
 const rows=giftMessages(store,session.id);assert.equal(rows.length,2);assert.equal(rows[0].count,5);assert.equal(rows[0].totalPrice,10);assert.equal(rows[0].time,22);
});
const join=(...parts)=>Buffer.concat(parts);
function varint(value){let v=BigInt(value),out=[];do{const b=Number(v&127n);v>>=7n;out.push(b|(v?128:0));}while(v);return Buffer.from(out);}
const n=(field,v)=>join(varint(field*8),varint(v)),b=(field,v)=>{v=Buffer.isBuffer(v)?v:Buffer.from(v);return join(varint(field*8+2),varint(v.length),v);};
test('Douyin gift protobuf reads room/time/price/artwork, bounds gift floods and retains ACK',()=>{
 const start=1793300000000;
 const payload=join(b(1,join(n(2,100),n(3,123),n(4,start/1000))),n(2,9),n(5,3),b(7,join(n(1,8),b(3,'昵称'))),n(11,44),b(15,join(b(1,b(1,'https://p3-webcast.douyinpic.com/gift.png')),n(12,10),b(16,'玫瑰'))));
 const raw={method:'WebcastGiftMessage',id:'100',payload},g=decodeGift(raw,{sourceStart:start,roomId:'123'});
 assert.equal(g.totalPrice,30);assert.equal(g.count,3);assert.equal(g.time,0);assert.equal(g.id,'combo:8:9:44');assert.ok(g.icon.endsWith('/gift.png'));
 assert.equal(decodeGift(raw,{sourceStart:start,roomId:'999'}),null);
 const msg=b(1,join(b(1,'WebcastGiftMessage'),b(2,payload))),frame=b(8,join(...Array.from({length:300},()=>msg),n(9,1)));
 const decoded=decodePushFrame(frame);assert.equal(decoded.messages.length,256);assert.equal(decoded.needAck,true);assert.equal(decoded.truncated,true);
});
test('gift queue deduplicates combo updates and keeps in-flight bytes bounded until acknowledgement',()=>{
 const intake=new GiftIntake({perRoom:1});intake.start('r');
 const g={id:'combo',count:1,time:3,user:'观众',name:'礼物',icon:''};
 assert.equal(intake.add('r',g),true);assert.equal(intake.add('r',{...g,count:3,time:5}),true);
 assert.equal(intake.add('r',{...g,id:'other'}),false);
 const batch=intake.take('r');assert.equal(batch.gifts[0].count,3);assert.equal(batch.gifts[0].time,3);assert.ok(intake.bytes>0);
 batch.release();assert.equal(intake.bytes,0);assert.equal(intake.add('r',g),true);assert.equal(intake.take('r'),null);
 intake.stop('r');intake.drop('r');
});
test('gift cards align clipped export time, cap simultaneous cards and escape ASS control text',()=>{
 const events=Array.from({length:4},(_,i)=>({id:String(i),time:i+1,type:'gift',user:'A{\\bad}',name:'B',platform:'bilibili',count:1,totalPrice:1}));
 assert.equal(giftCards(events,4).length,3);assert.equal(giftCards(events,10).length,0);
 for(const s of giftSegments(events,3,6))assert.ok(s.start>=3&&s.end<=6&&s.events.length<=3);
 const ass=giftAss(events,1280,720,{base:3,from:3,to:6});assert.match(ass,/0:00:00.00/);assert.ok(!ass.includes('{\\bad}'));
});
test('artwork only fetches known platform URLs; responses are bounded, decoded and cached',async t=>{
 const {store,source}=await fixture(t);
 for(const value of ['https://127.0.0.1/a','https://p3-webcast.douyinpic.com.evil.example/a','https://x:y@i0.hdslb.com/a','https://i0.hdslb.com:444/a'])assert.equal(safeGiftIcon(value),'');
 const icon='https://i0.hdslb.com/bfs/live/gift.png';saveGift(store,giftFromXml('gift',{ts:1,icon,giftid:'9'},source,1));
 let calls=0;const icons=new GiftIcons(store,{request:async(url,options)=>{calls++;assert.equal(url,icon);assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,undefined);return new Response(Buffer.from('png-source'));},normalize:async()=>Buffer.from('normalized-png')});t.after(()=>icons.close());
 assert.equal((await icons.get(giftIconKey(icon))).toString(),'normalized-png');assert.equal((await icons.get(giftIconKey(icon))).toString(),'normalized-png');assert.equal(calls,1);
 assert.equal(await icons.get('0'.repeat(64)),null);
});
test('unavailable artwork has one submission deadline and never blocks gift navigation or starts all downloads',async t=>{
 const {store,source}=await fixture(t),gifts=[];let calls=0;
 for(let i=0;i<20;i++){const g=giftFromXml('gift',{ts:i,icon:`https://i0.hdslb.com/bfs/live/${i}.png`},source,i);saveGift(store,g);gifts.push(g);}
 const icons=new GiftIcons(store,{request:async(_url,{signal})=>{calls++;await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}});t.after(()=>icons.close());
 const started=Date.now(),snapshot=await icons.snapshot(gifts,{timeoutMs:50});
 assert.deepEqual(snapshot,{});assert.equal(calls,4);assert.ok(Date.now()-started<1000);assert.equal(giftMessages(store,source.session).length,20);
});
test('gift settings persist separately, gifts API filters by value and chat stays chat-only',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gift-api-'));let app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'unused',ffprobe:'unused'});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
 assert.deepEqual(app.snapshot().giftStyle,DEFAULT_GIFT_STYLE);
 const session=app.store.createSession({status:'finished'}),source=app.store.addSource(session.id,path.join(root,'one.flv'));
 saveGift(app.store,giftFromXml('guard',{ts:12,level:3,total_coin:198000,coin_type:'gold'},source,1));
 const base=`http://127.0.0.1:${app.port}/api/`,style={...DEFAULT_GIFT_STYLE,preview:true,minBilibili:100};
 const post=async data=>fetch(base+'settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post({giftStyle:style})).status,200);assert.deepEqual(app.snapshot().giftStyle,style);
 assert.equal((await post({giftStyle:{...style,minBilibili:-1},previewTimestamp:true})).status,400);assert.equal(app.snapshot().previewTimestamp,false);
 const response=await fetch(base+`sessions/${session.id}/gifts`);assert.equal(response.status,200);const rows=await response.json();assert.equal(rows[0].name,'舰长');assert.equal(rows[0].time,12);
 assert.deepEqual(await (await fetch(base+`sessions/${session.id}/messages`)).json(),[]);
 assert.equal((await fetch(base+`sessions/${session.id}/gifts?from=-1`)).status,400);
});
