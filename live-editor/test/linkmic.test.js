import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { LinkmicIndex, linkmicAss } from '../server/linkmic.js';
import { linkmicSei, parsePlatformJson } from '../server/linkmic-sei.js';
import { labelGeometry, labelsAt, participantName } from '../shared/linkmic-labels.js';
import { FLV_HEADER } from '../server/ingest.js';
import { DouyinResolver } from '../server/douyin-room.js';

// Shapes captured from the two supplied public streams on 2026-10-20;
// identifiers and names are replaced. No stream URL, visitor token or profile.
const bili=()=>({LIVE_MULTI_VIDEO_LINK:{session_status:1,sei_room_status:1,
  interact_template:{show_interact_ui:true,layout_data:{width:10,height:8,cells:[
    {position:0,x:0,y:0,width:5,height:8},{position:1,x:5,y:0,width:5,height:4},{position:2,x:5,y:4,width:5,height:4}]}},
  members:[{position:2,uid_str:'103',uname:'嘉宾乙'},{position:0,uid_str:'101',uname:'本房主播名字'},{position:1,uid_str:'102',uname:'嘉宾甲'}]}});
const douyin=()=>({app_data:JSON.stringify({vendor:'BYTE',canvas:{width:1080,height:780},channel_id:'7698675449551328282',ver:2,
  grids:[{uid_str:'1_remote',x:.5,y:0,w:.5,h:1}],anchor_interact_info:{layout_type:0,focus_id:'1_owner'}}),
  live_crop:{crop_x:0,crop_y:360,crop_w:1080,crop_h:780,stride_w:1080,stride_h:1920}});
// Captured audience protocol: order differs from seats; -1 is the host,
// 0 is the bottom video guest and 1 is the voice guest immediately above.
const audience=(overrides={})=>({app_data:JSON.stringify({ver:15,ui_layout:7,interactive_scene:8,hide_micseat:0,
  channel_id:'998',canvas:{width:360,height:640},grids:[
    {p:-1,type:1,uid_str:'1_owner'},{p:1,type:2,uid_str:'2_voice'},{p:0,type:1,uid_str:'3_video'}],...overrides})});
function seiTag(value,type=5,time=0,lengthSize=4) {
  const payload=Buffer.from((type===5?'LIVE_SEI_CHANNEL':'')+JSON.stringify(value)),size=[];
  for(let n=payload.length;n>=255;n-=255)size.push(255);size.push(payload.length%255);
  const raw=Buffer.concat([Buffer.from([type,...size]),payload,Buffer.from([128])]),escaped=[];
  for(let i=0;i<raw.length;i++){if(i>=2&&raw[i]<=3&&raw[i-1]===0&&raw[i-2]===0)escaped.push(3);escaped.push(raw[i]);}
  const nalu=Buffer.concat([Buffer.from([6]),Buffer.from(escaped)]),length=Buffer.alloc(lengthSize);length.writeUIntBE(nalu.length,0,lengthSize);
  const body=Buffer.concat([Buffer.from([0x27,1,0,0,0]),length,nalu]),tag=Buffer.alloc(body.length+15);
  tag[0]=9;tag.writeUIntBE(body.length,1,3);tag.writeUIntBE(time*1000,4,3);body.copy(tag,11);tag.writeUInt32BE(tag.length-4,tag.length-4);return tag;
}
test('Bilibili matches members to explicit cells, not array order; no guessed placement',()=>{
  const result=linkmicSei(seiTag(bili()))[0];
  assert.deepEqual(result.participants.find(p=>p.id==='103'),{x:.5,y:.5,w:.5,h:.5,id:'103',name:'嘉宾乙'});
  const missing=bili();delete missing.LIVE_MULTI_VIDEO_LINK.interact_template.layout_data;
  assert.deepEqual(linkmicSei(seiTag(missing)),[]);
  const stopped=bili();stopped.LIVE_MULTI_VIDEO_LINK.sei_room_status=0;
  assert.deepEqual(linkmicSei(seiTag(stopped))[0].participants,[]);
  const grid=bili().LIVE_MULTI_VIDEO_LINK;
  grid.interact_template.layout_data={width:12,height:12,cells:[{position:0,x:0,y:0,width:6,height:12},
    ...Array.from({length:6},(_,i)=>({position:i+1,x:6+(i%2)*3,y:Math.floor(i/2)*4,width:3,height:4}))]};
  grid.members=Array.from({length:6},(_,i)=>({position:i,uid_str:String(100+i),uname:'主播'+i}));
  const multi=linkmicSei(seiTag({LIVE_MULTI_VIDEO_LINK:grid}))[0].participants;
  assert.equal(multi.length,6,'empty seventh seat receives no name');
  assert.deepEqual(multi[5],{x:.5,y:2/3,w:.25,h:1/3,id:'105',name:'主播5'});
});
test('Douyin positions labels inside the real PK crop, not the full portrait canvas',()=>{
  const result=linkmicSei(seiTag(douyin(),100))[0];
  assert.equal(result.channel,'7698675449551328282');
  assert.deepEqual(result.participants.map(p=>[p.x,p.y,p.w,p.h]),[[0,.1875,.5,.40625],[.5,.1875,.5,.40625]]);
  assert.equal(result.participants[0].owner,true);
  assert.equal(result.participants[0].linkId,'');
  const multi={app_data:JSON.stringify({channel_id:'99',ver:6,grids:[{uid_str:'a',x:0,y:0,w:.5,h:.5},{uid_str:'b',x:.5,y:.5,w:.5,h:.5}]})};
  assert.equal(linkmicSei(seiTag(multi,100))[0].participants.length,2);
});
test('bounded SEI parsing handles NAL length sizes, unrelated messages, invalid rectangles and uint64 IDs',()=>{
  for(const size of [2,3,4])assert.equal(linkmicSei(seiTag(bili(),5,0,size),size)[0].participants.length,3);
  assert.deepEqual(linkmicSei(seiTag({app_data:'{broken'},100)),[]);
  const bad=bili();bad.LIVE_MULTI_VIDEO_LINK.interact_template.layout_data.cells[0].x=20;
  assert.equal(linkmicSei(seiTag(bad))[0].participants.length,2);
  assert.equal(parsePlatformJson('{"id":7698675449551328282}').id,'7698675449551328282');
  const bytes=seiTag(bili());for(let i=0;i<bytes.length;i+=17)assert.doesNotThrow(()=>linkmicSei(bytes.subarray(0,i)));
});
test('audience floating seats match native bottom-up positions and preserve host and guest IDs',()=>{
  const people=linkmicSei(seiTag(audience(),100))[0].participants;
  assert.equal(people.length,3);
  assert.deepEqual(people[0],{x:0,y:0,w:1,h:1,linkId:'1_owner',owner:true});
  const voice=people.find(p=>p.linkId==='2_voice'),video=people.find(p=>p.linkId==='3_video');
  assert.equal(voice.audioOnly,true);assert.equal(video.audioOnly,undefined);
  const cameraOn=linkmicSei(seiTag(audience({grids:[{p:1,type:1,uid_str:'2_voice'}]}),100))[0].participants[0];
  assert.equal(cameraOn.audioOnly,undefined,'opening the camera removes the avatar card');
  assert.equal(video.x,.761);assert.equal(video.w,.205);
  assert.ok(Math.abs(video.y+video.h-(1-.149*360/640))<1e-9);
  assert.ok(Math.abs(voice.y+voice.h-video.y)<1e-9);
  assert.equal(participantName({...video,id:'52934577773'}),'ID 52934577773');
  for(const changes of [{hide_micseat:1},{ui_layout:99},{interactive_scene:1},{canvas:{width:0,height:640}}])
    assert.equal(linkmicSei(seiTag(audience(changes),100))[0].participants.length,0);
  const six=Array.from({length:6},(_,p)=>({p,uid_str:'seat_'+p,type:2}));
  assert.equal(linkmicSei(seiTag(audience({grids:six}),100))[0].participants.length,6);
  assert.equal(linkmicSei(seiTag(audience({grids:[six[0],six[0]]}),100))[0].participants.length,0);
  assert.equal(linkmicSei(seiTag(audience({grids:[{...six[0],visible:0}]}),100))[0].participants.length,0);
});
test('geometry fits portrait and landscape letterboxing, bounds long names and escapes ASS tags',()=>{
  const p={x:.5,y:.1875,w:.5,h:.40625,name:'嘉宾{\\pos(0,0)}'.repeat(20)};
  const g=labelGeometry(p,854,480,1080,1920);
  assert.ok(g.x<563&&g.x>500);assert.ok(g.y<285&&g.y>270);assert.ok(g.text.endsWith('…'));
  const ass=linkmicAss([{time:8,end:12,participants:[p]}],1080,1920,{base:7,from:9,to:11});
  assert.match(ass,/Dialogue: 2,0:00:02.00,0:00:04.00/);assert.doesNotMatch(ass,/\{\\pos\(0,0\)\}/);
  assert.equal(labelsAt([{time:1,end:2,participants:[p]}],2).length,0);
});
test('index deduplicates repeated SEI, expires missing updates, survives restart, backfills old originals',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-'));
  const store=new Store(root);t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession({status:'finished'}),file=path.join(root,'sample.flv');
  const changed=bili();changed.LIVE_MULTI_VIDEO_LINK.members[0].uname='换名字';
  const off=bili();off.LIVE_MULTI_VIDEO_LINK.session_status=0;
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,seiTag(bili(),5,1),seiTag(bili(),5,2),seiTag(changed,5,4),seiTag(off,5,5),seiTag(bili(),5,15)]));
  const source=store.addSource(session.id,file,10,new Date().toISOString(),true);
  store.run('UPDATE sources SET duration=30,closed=2 WHERE id=?',source.id);
  let index=new LinkmicIndex(store);await index.ensure(session.id);
  let events=index.events(session.id);assert.equal(events.length,4);assert.equal(events[0].time,11);assert.equal(events[0].end,14);
  assert.equal(labelsAt(events,15.1).length,0);assert.equal(labelsAt(events,32).length,0);
  await index.close();
  // Upgrading support must remove previously indexed empty frames, not let
  // them shadow a new, longer identity interval during playback.
  const old=store.setting('linkmic-index:'+source.id);store.setting('linkmic-index:'+source.id,{...old,version:1});
  store.run('INSERT INTO linkmic_frames VALUES(?,?,?,?)',source.id,11.5,12,JSON.stringify({platform:'douyin',participants:[]}));
  index=new LinkmicIndex(store);await index.ensure(session.id);
  assert.deepEqual(index.events(session.id),events);await index.close();
});
test('audience roster uses its own endpoint and matches by link ID rather than list position',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-audience-roster-')),store=new Store(root),requests=[];
  const resolver=new DouyinResolver({request:async url=>{
    requests.push(String(url));return new Response(JSON.stringify({status_code:0,data:{user:[
      {linkmic_id_str:'3_video',user_position:1,user:{id_str:'103',nickname:'视频用户'}},
      {linkmic_id_str:'2_voice',user_position:2,user:{id_str:'102',nickname:'',avatar_thumb:{url_list:['https://p3.douyinpic.com/avatar.jpeg']}}},
      {linkmic_id_str:'unrelated',user:{id_str:'104',nickname:'其他用户'}}]}}));
  }});resolver.visitor={cookie:'visitor-only',expires:Date.now()+60000};
  const session=store.createSession(),file=path.join(root,'sample.flv');
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,seiTag(audience(),100,1)]));
  const source=store.addSource(session.id,file);store.run('UPDATE sources SET duration=3 WHERE id=?',source.id);
  store.setting('linkmic-owner:'+source.id,{id:'101',name:'当前主播',roomId:'998'});
  const captures=[];
  const index=new LinkmicIndex(store,{resolver,avatars:{capture:async(source,channel,person)=>{
    captures.push([source.id,channel,person.linkId,person.avatarUrl]);throw new Error('temporary image outage');
  }}});
  t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  await index.ensure(session.id);await Promise.all(index.refreshes.values());
  const labels=labelsAt(index.events(session.id),2).map(participantName);
  assert.deepEqual(labels,['当前主播','ID 102','视频用户']);
  assert.equal(new URL(requests[0]).pathname,'/webcast/linkmic_audience/list/v2/');
  assert.equal(new URL(requests[0]).searchParams.get('anchor_id'),'101');
  assert.deepEqual(captures,[[source.id,'998','2_voice','https://p3.douyinpic.com/avatar.jpeg']],'only the matched voice guest is fetched; download failure preserves names and video');
});
test('old sources without originals recover names from retained chunks and source-relative timing',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-chunks-')),store=new Store(root);
  const session=store.createSession({status:'finished'}),source=store.addSource(session.id,path.join(root,'missing.flv'),100,undefined,true);
  store.run('UPDATE sources SET duration=10,closed=2 WHERE id=?',source.id);
  const file=path.join(root,'chunk'),bytes=seiTag(bili(),5,3);await fs.writeFile(file,bytes);
  store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',source.id,0,103,104,file,bytes.length);
  const index=new LinkmicIndex(store);t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  await index.ensure(session.id);assert.equal(index.events(session.id)[0].time,103);
  assert.equal(index.events(session.id)[0].participants[0].name,'嘉宾乙');
});
test('Douyin roster uses exact channel/link IDs, and roster errors do not stop indexing',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-roster-')),store=new Store(root);
  const session=store.createSession(),file=path.join(root,'sample.flv');
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,seiTag(douyin(),100,1)]));
  const source=store.addSource(session.id,file);store.run('UPDATE sources SET duration=3 WHERE id=?',source.id);
  store.setting('linkmic-owner:'+source.id,{id:'101',name:'本房昵称',roomId:'999'});
  const index=new LinkmicIndex(store,{resolver:{async linkmic(args){assert.equal(args.channel,'7698675449551328282');return [{linkId:'1_remote',id:'102',name:'远端昵称'},{linkId:'different',id:'103',name:'错误位置'}];}}});
  t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  await index.ensure(session.id);await Promise.all(index.refreshes.values());
  assert.deepEqual(index.events(session.id)[0].participants.map(p=>p.name),['本房昵称','远端昵称']);
  const requests=[];const resolver=new DouyinResolver({request:async(url)=>{requests.push(url);return new Response(JSON.stringify({status_code:0,data:{user:[{linkmic_id_str:'remote',user:{id_str:'100',nickname:'昵称'}}]}}));}});
  resolver.visitor={cookie:'visitor-only',expires:Date.now()+60000};
  assert.equal((await resolver.linkmic({roomId:'9',anchorId:'8',channel:'7698675449551328282',version:2}))[0].name,'昵称');
  assert.ok(requests[0].includes('channel_id=7698675449551328282'));
});
