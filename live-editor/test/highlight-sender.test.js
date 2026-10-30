import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {createApp} from '../server/index.js';
import {chatXml} from '../server/douyin-recorder.js';
import {ChatIntake} from '../server/chat-intake.js';
import {senderFilterFor,validateSenderFilter} from '../shared/sender-filter.js';
import {senderFromXml} from '../server/senders.js';
import {DEFAULT_HIGHLIGHT_STYLE,validateHighlightStyle} from '../shared/highlight-style.js';
import {DEFAULT_DANMAKU_STYLE,danmakuGeometry} from '../shared/danmaku-style.js';
import {layoutComments,layoutCommentsAsync,commentSignature} from '../server/render-plan.js';
import {layoutDanmaku} from '../src/danmaku-layout.js';
import {assText} from '../server/media.js';
import {DEFAULT_GIFT_STYLE,validateGiftStyle,giftPrice,giftYuan} from '../shared/gifts.js';
import {giftFromXml,saveGift,giftMessages} from '../server/gifts.js';
import {decodeChat} from '../server/douyin-protocol.js';
const temporary=async()=>fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'highlight-'));
test('yuan display and thresholds retain raw platform amounts and migrate older coin thresholds',async t=>{
 const root=await temporary(),store=new Store(root),session=store.createSession(),source=store.addSource(session.id,path.join(root,'one.flv'));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 assert.equal(giftPrice({platform:'douyin',totalPrice:15}),'¥1.5');assert.equal(giftYuan({platform:'bilibili',totalPrice:1.5}),1.5);
 assert.deepEqual(validateGiftStyle({preview:true,export:false,minBilibili:2,minDouyin:20}),{preview:true,export:false,minBilibili:2,minDouyin:2,currency:'CNY'});
 for(const [i,price] of [10,50,null].entries())saveGift(store,giftFromXml('gift',{platform:'douyin',ts:i,...(price===null?{}:{total_price:price})},source,i));
 const rows=giftMessages(store,session.id,{style:{...DEFAULT_GIFT_STYLE,minDouyin:2}});assert.equal(rows.length,1);assert.equal(rows[0].totalPrice,50);assert.match(rows[0].text,/¥5/);
});
test('legacy Bili identities backfill without moving XML cursors; UID filters survive nickname changes and exclude namesakes',async t=>{
 const root=await temporary(),store=new Store(root),session=store.createSession(),source=store.addSource(session.id,path.join(root,'one.flv')),ingest=new Ingestor(store);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 const d=(time,uid,name,text)=>`<d p="${time},1,25,16777215,0,0,${uid},0" user="${name}">${text}</d>`;
 await fs.writeFile(source.xml,'<i>'+d(1,'123','同名观众','第一条')+d(2,'456','同名观众','第二条')+d(3,'123','改名后','第三条')+d(4,'0','小%星A','第四条')+d(5,'0','小%月A','第五条')+'</i>');
 await ingest.readDanmaku(source);const pos=store.get('SELECT xmlpos FROM sources WHERE id=?',source.id).xmlpos;
 store.run('DELETE FROM danmaku_senders');assert.equal(store.messages(session.id)[0].senderId,null);
 await store.senders.prepare(session.id);assert.equal(store.get('SELECT xmlpos FROM sources WHERE id=?',source.id).xmlpos,pos);assert.equal(store.messages(session.id).length,5);
 const rows=store.messages(session.id,0,10,'',500,true,undefined,{mode:'uid',platform:'bilibili',uid:'123',name:'同名观众'});
 assert.deepEqual(rows.map(m=>m.user),['同名观众','改名后']);assert.deepEqual(senderFilterFor(rows[0]),{mode:'uid',platform:'bilibili',uid:'123',name:'同名观众'});
 const approximate={mode:'approx',name:'小%***A',prefix:'小%',suffix:'A'};
 assert.equal(store.messages(session.id,0,10,'',500,true,undefined,approximate).length,2);
 await store.senders.prepare(session.id);assert.equal(store.get('SELECT COUNT(*) AS n FROM danmaku_senders').n,3);
 assert.equal(senderFilterFor({user:'观众'}),null);assert.equal(senderFilterFor({user:'小***A'}).mode,'approx');assert.throws(()=>validateSenderFilter({...approximate,prefix:''}));
});
test('Douyin sender ID is captured separately from the message ID; historical message IDs are never treated as users',async t=>{
 const root=await temporary(),store=new Store(root),session=store.createSession(),source=store.addSource(session.id,path.join(root,'douyin.flv'));t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
 store.setting('douyin-session:'+session.id,{platform:'douyin'});
 assert.equal(senderFromXml({uid:'999',p:'1,1,25,0,0,0,999,0'},source,store),null);
 const intake=new ChatIntake({now:()=>1000});intake.start('r',{start:0});intake.add('r',{id:'999',senderId:'123',time:1,text:'普通聊天',user:'用户A'});
 const batch=intake.take('r',{force:true});assert.equal(batch.messages[0].senderId,'123');
 await fs.writeFile(source.xml,'<i>'+chatXml({...batch,density:[]})+'</i>');batch.release();await new Ingestor(store).readDanmaku(source);
 assert.equal(store.messages(session.id)[0].senderId,'123');assert.equal(store.messages(session.id)[0].senderPlatform,'douyin');
});
test('real Douyin chat schema keeps a 64-bit sender identity distinct from its event ID',()=>{
 const varint=value=>{let n=BigInt(value),out=[];do{let byte=Number(n&127n);n>>=7n;if(n)byte|=128;out.push(byte);}while(n);return Buffer.from(out);};
 const n=(field,value)=>Buffer.concat([varint(field*8),varint(value)]),b=(field,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([varint(field*8+2),varint(bytes.length),bytes]);};
 const payload=Buffer.concat([b(1,Buffer.concat([n(2,999),n(3,1234),n(4,1793300001)])),b(2,Buffer.concat([n(1,'9007199254740993'),b(3,'用户A')])),b(3,'普通聊天')]);
 const chat=decodeChat({method:'WebcastChatMessage',id:'999',payload},{sourceStart:1793300000000,roomId:'1234'});
 assert.equal(chat.senderId,'9007199254740993');assert.equal(chat.id,'999');assert.equal(chat.user,'用户A');
});
test('mixed highlight sizes, sender prefixes and colors share browser/export layout and reserve actual glyph height',async()=>{
 assert.deepEqual(DEFAULT_HIGHLIGHT_STYLE,{scale:1,showSender:false,color:null});
 for(const value of [{scale:.9,showSender:false,color:null},{scale:3.1,showSender:false,color:null},{scale:2,showSender:1,color:null},{scale:2,showSender:false,color:'red'}])assert.throws(()=>validateHighlightStyle(value));
 const raw=Array.from({length:8},(_,i)=>({id:String(i),time:0,type:'d',text:'SAMPLE',user:'USER',color:'16777215',...(i<2?{highlighted:true}:{})}));
 const highlightStyle={scale:3,showSender:true,color:'#1234AB'},g=danmakuGeometry(720,DEFAULT_DANMAKU_STYLE),options={width:1280,height:720,style:DEFAULT_DANMAKU_STYLE,highlightStyle};
 const output=layoutComments(raw,options),preview=[...layoutDanmaku(raw,{width:1280,height:720,...{fontSize:g.size,lineHeight:g.lineHeight,top:g.top,maxLanes:g.lanes},exportLayout:true,highlightStyle}).values()];
 assert.deepEqual(preview,output);assert.equal(output[0].fontSize,g.size*3);assert.equal(output[0].text,'USER：SAMPLE');assert.equal(output[0].renderColor,0x1234AB);assert.equal(output[2].fontSize,undefined);
 for(let i=0;i<output.length;i++)for(let j=0;j<i;j++){
  const a=output[i],b=output[j],ah=(a.fontSize??g.size)*1.4+4,bh=(b.fontSize??g.size)*1.4+4;
  assert.ok(Math.min(a.y+ah,b.y+bh)-Math.max(a.y,b.y)<.01,'sparse comments reserve real vertical size');
 }
 const state={},resumed=[];for(let n=0;n<raw.length;n+=3)resumed.push(...await layoutCommentsAsync(raw.slice(n,n+3),{...options,state}));assert.deepEqual(resumed,output);
 const ass=assText(output);assert.match(ass,/\\fs60/);assert.match(ass,/\\1c&HAB3412&/);assert.match(ass,/USER：SAMPLE/);
 assert.notEqual(commentSignature(output),commentSignature(layoutComments(raw,{...options,highlightStyle:{...highlightStyle,scale:1}})));
});
test('API filters before LIMIT, validates edits/settings atomically and persists independent single-message highlights',async t=>{
 const root=await temporary(),app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'unused',ffprobe:'unused'});t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
 const session=app.store.createSession({status:'finished'});app.store.run('UPDATE sessions SET duration=20 WHERE id=?',session.id);
 for(let i=0;i<510;i++){const id='m'+i;app.store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',id,session.id,'source',i/50,'用户','普通弹幕'+i,'d','16777215');app.store.run('INSERT INTO danmaku_senders VALUES(?,?,?)',id,'bilibili',i<509?'1':'2');}
 const base=`http://127.0.0.1:${app.port}/api/`,post=(url,data)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const filter={mode:'uid',platform:'bilibili',uid:'2',name:'用户'},rows=await(await fetch(base+`sessions/${session.id}/messages?sender=${encodeURIComponent(JSON.stringify(filter))}`)).json();assert.equal(rows.length,1);assert.equal(rows[0].id,'m509');
 const settings={scale:2.3,showSender:true,color:'#00fF00'};assert.equal((await post('settings',{highlightStyle:settings})).status,200);assert.equal(app.snapshot().highlightStyle.color,'#00FF00');
 assert.equal((await post('settings',{highlightStyle:{...settings,scale:4},previewTimestamp:true})).status,400);assert.equal(app.snapshot().previewTimestamp,false);
 let edit=app.store.edit(session.id);edit=await(await post(`sessions/${session.id}/edit`,{...edit,highlighted:['m509']})).json();assert.deepEqual(edit.highlighted,['m509']);assert.equal(edit.excluded.length,0);
 assert.equal((await post(`sessions/${session.id}/edit`,{...edit,highlighted:'m1'})).status,400);
 const cleared=await(await post(`sessions/${session.id}/edit`,{...edit,highlighted:[]})).json();assert.deepEqual(cleared.highlighted||[],[]);
 assert.equal((await fetch(base+`sessions/${session.id}/messages?sender=bad`)).status,400);
});
