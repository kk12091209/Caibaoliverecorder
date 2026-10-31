import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {createApp} from '../server/index.js';
import {RenderPipeline,layoutComments,layoutCommentsAsync,commentSignature} from '../server/render-plan.js';
import {assText} from '../server/media.js';
import {applyMessageEdit,validateMessageEdits,messageEditsKey} from '../shared/message-edits.js';
import {senderFilterFor,matchesSender} from '../shared/sender-filter.js';
import {layoutDanmaku} from '../src/danmaku-layout.js';
import {danmakuGeometry,DEFAULT_DANMAKU_STYLE} from '../shared/danmaku-style.js';

const temporary=()=>fs.mkdtemp(path.join(os.tmpdir(),'message-edits-'));
function insert(store,session,id,time=1,user='原昵称',text='原弹幕'){
  store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',id,session,'source',time,user,text,'d','16777215');
}

test('corrections persist separately, preserve identity and other comments, and support restoration and revision conflicts',async t=>{
  const root=await temporary();let store=new Store(root);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession();insert(store,session.id,'one');insert(store,session.id,'two',2);
  store.run('INSERT INTO danmaku_senders VALUES(?,?,?)','one','bilibili','123');
  const patch={user:'安全昵称',text:'修正：错别字'},saved=store.saveEdit(session.id,{...store.edit(session.id),messageEdits:{one:patch},highlighted:['one']});
  assert.equal(store.get('SELECT user FROM danmaku WHERE id=?','one').user,'原昵称');
  assert.equal(store.get('SELECT text FROM danmaku WHERE id=?','one').text,'原弹幕');
  assert.deepEqual(store.messages(session.id).map(m=>[m.user,m.text]),[['安全昵称','修正：错别字'],['原昵称','原弹幕']]);
  const row=store.messages(session.id)[0];assert.equal(row.originalUser,'原昵称');assert.equal(row.originalText,'原弹幕');
  assert.deepEqual(senderFilterFor(row),{mode:'uid',platform:'bilibili',uid:'123',name:'原昵称'});
  assert.ok(matchesSender(row,{mode:'name',name:'原昵称'}));assert.equal(senderFilterFor({...row,senderId:null}).name,'原昵称');
  assert.throws(()=>store.saveEdit(session.id,{...saved,revision:0}),e=>e.status===409);
  const {messageEdits,...legacy}=saved;store.saveEdit(session.id,legacy);assert.deepEqual(store.edit(session.id).messageEdits,{one:patch});
  store.close();store=new Store(root);assert.deepEqual(store.edit(session.id).messageEdits,{one:patch});
  const renderer=new RenderPipeline({store},assText),corrected=await renderer.layout(session.id,undefined,50,{messageEdits:{one:patch}}),original=await renderer.layout(session.id,undefined,50,{messageEdits:{}});
  assert.equal(corrected[0].text,patch.text);assert.equal(original[0].text,'原弹幕');assert.notEqual(commentSignature(corrected),commentSignature(original));assert.equal(renderer.lastLayoutWork.incremental,false);
  store.saveEdit(session.id,{...store.edit(session.id),messageEdits:{}});assert.equal(store.messages(session.id)[0].user,'原昵称');
});

test('edited text is searched before LIMIT; playback anchors and sender filters still target captured identities',async t=>{
  const root=await temporary(),store=new Store(root);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession();
  for(let i=0;i<510;i++)insert(store,session.id,'m'+i,i*2,'原观众','普通聊天'+i);
  store.saveEdit(session.id,{...store.edit(session.id),messageEdits:{m509:{user:'已匿名',text:'罕见修正词'}}});
  assert.equal(store.messages(session.id,0,2000,'罕见修正词',500)[0].id,'m509');assert.equal(store.messages(session.id,0,2000,'已匿名',500)[0].id,'m509');
  const anchored=store.messages(session.id,0,2000,'',10,true,1018);assert.equal(anchored.at(-1).id,'m509');assert.ok(anchored.every((m,i)=>!i||m.time>=anchored[i-1].time));
  const rows=store.messages(session.id,1000,2000,'',500,true,undefined,{mode:'name',name:'原观众'});assert.equal(rows.at(-1).user,'已匿名');
  assert.equal(store.messages(session.id,0,2000,'',500,true,undefined,{mode:'name',name:'已匿名'}).length,0);
});

test('validation rejects foreign, missing, gift and malformed edits atomically without losing existing corrections',async t=>{
  const root=await temporary(),store=new Store(root);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const a=store.createSession(),b=store.createSession();insert(store,a.id,'a');insert(store,b.id,'b');insert(store,a.id,'gift');store.run("UPDATE danmaku SET type='gift' WHERE id='gift'");
  const patch={user:'昵称',text:'修正内容'};store.saveEdit(a.id,{...store.edit(a.id),messageEdits:{a:patch}});const before=store.edit(a.id);
  for(const bad of [null,[],{missing:patch},{b:patch},{gift:patch},{a:{...patch,text:''}},{a:{...patch,user:'  '}},{a:{...patch,text:'bad\nline'}},{a:{...patch,text:'a'.repeat(501)}},{a:{...patch,user:'a'.repeat(201)}},{a:{...patch,uid:'123'}}]){
    assert.throws(()=>store.saveEdit(a.id,{...before,messageEdits:bad}));assert.deepEqual(store.edit(a.id),before);
  }
  const special=validateMessageEdits(JSON.parse('{"__proto__":{"user":"昵称","text":"内容"}}'));assert.equal(Object.keys(special)[0],'__proto__');assert.equal({}.text,undefined);
  assert.equal(messageEditsKey({b:patch,a:patch}),messageEditsKey({a:patch,b:patch}));
});

test('edited nickname prefix, punctuation and highlight layout agree between browser and ASS export without mutating raw rows',async()=>{
  const raw=[{id:'one',time:1,type:'d',user:'SENSITIVE',text:'MISTAKE',color:'16777215'}],patches={one:{user:'SAFE',text:'CORRECT: A <B> {C} \\D'}};
  const highlightStyle={scale:2,showSender:true,color:'#00FF00'},geometry=danmakuGeometry(720,DEFAULT_DANMAKU_STYLE),options={highlightStyle,highlighted:['one'],messageEdits:patches};
  const exported=layoutComments(raw,options),preview=[...layoutDanmaku(raw.map(m=>({...applyMessageEdit(m,patches),highlighted:true})),{width:1280,height:720,fontSize:geometry.size,lineHeight:geometry.lineHeight,top:geometry.top,maxLanes:geometry.lanes,exportLayout:true,highlightStyle}).values()];
  assert.deepEqual(exported,preview);assert.deepEqual(await layoutCommentsAsync(raw,options),exported);
  assert.equal(exported[0].text,'SAFE：CORRECT: A <B>  C   D');assert.equal(raw[0].user,'SENSITIVE');assert.equal(raw[0].text,'MISTAKE');
  const ass=assText(exported);assert.match(ass,/SAFE：CORRECT/);assert.doesNotMatch(ass,/SENSITIVE|MISTAKE/);
  assert.equal(layoutComments(raw,{...options,highlightStyle:{...highlightStyle,showSender:false}})[0].text,'CORRECT: A <B>  C   D');
});

test('local API persists correction, returns it in list and overlay, invalidates preparation and restores original',async t=>{
  const root=await temporary(),app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'unused',ffprobe:'unused'});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
  const session=app.store.createSession({status:'finished'});insert(app.store,session.id,'a');
  const base=`http://127.0.0.1:${app.port}/api/sessions/${session.id}`,post=data=>fetch(base+'/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const invalidated=[];app.preparation.invalidate=async id=>{invalidated.push(id);};
  let saved=await(await post({...app.store.edit(session.id),messageEdits:{a:{user:'匿名观众',text:'修正文本'}}})).json();assert.deepEqual(invalidated,[session.id]);
  for(const suffix of ['/messages?q='+encodeURIComponent('修正文本'),'/messages?overlay=1']){
    const rows=await(await fetch(base+suffix)).json();assert.equal(rows[0].text,'修正文本');assert.equal(rows[0].user,'匿名观众');
  }
  assert.equal((await post({...saved,messageEdits:{a:{user:'匿名观众',text:''}}})).status,400);assert.deepEqual(app.store.edit(session.id),saved);
  saved=await(await post({...saved,messageEdits:{}})).json();assert.equal(saved.messageEdits,undefined);assert.equal(app.store.messages(session.id)[0].text,'原弹幕');assert.equal(invalidated.length,2);
});
