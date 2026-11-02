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
import { seiTag } from './helpers/linkmic-sei.js';

// Shapes captured from the two supplied public streams on 2026-10-20;
// identifiers and names are replaced. No stream URL, visitor token or profile.
const bili=()=>({LIVE_MULTI_VIDEO_LINK:{session_status:1,sei_room_status:1,
  interact_template:{show_interact_ui:true,layout_data:{width:10,height:8,cells:[
    {position:0,x:0,y:0,width:5,height:8},{position:1,x:5,y:0,width:5,height:4},{position:2,x:5,y:4,width:5,height:4}]}},
  members:[{position:2,uid_str:'103',uname:'嘉宾乙'},{position:0,uid_str:'101',uname:'本房主播名字'},{position:1,uid_str:'102',uname:'嘉宾甲'}]}});
const douyin=()=>({app_data:JSON.stringify({vendor:'BYTE',canvas:{width:1080,height:780},channel_id:'7698675449551328282',ver:2,
  grids:[{uid_str:'1_remote',x:.5,y:0,w:.5,h:1}],anchor_interact_info:{layout_type:0,focus_id:'1_owner'}}),
  live_crop:{crop_x:0,crop_y:360,crop_w:1080,crop_h:780,stride_w:1080,stride_h:1920}});
// Captured audience protocol: order differs from seats; -1 is the main picture,
// 0 is the bottom video guest and 1 is the voice guest immediately above.
const audience=(overrides={})=>({app_data:JSON.stringify({ver:15,ui_layout:7,interactive_scene:8,hide_micseat:0,
  channel_id:'998',canvas:{width:360,height:640},grids:[
    {p:-1,type:1,uid_str:'1_owner'},{p:1,type:2,uid_str:'2_voice'},{p:0,type:1,uid_str:'3_video'}],...overrides})});
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
// Shape from the 2026-11-02 public game/camera stream; identities replaced.
const gameLink=()=>({app_data:JSON.stringify({ver:6,channel_id:'7703214997949912100',is_game:true,
  grids:[{uid_str:'host_camera',x:0,y:2/3,w:.5,h:1/3},{uid_str:'guest_camera',x:.5,y:2/3,w:.5,h:1/3},
    {uid_str:'mock_game_uid',x:0,y:0,w:1,h:2/3,is_game:1}]})});
test('NUL-terminated Douyin game SEI retains both camera identities and rejects non-padding suffixes',()=>{
  for(const suffix of ['', '\0', '\0\0']){
    const frame=linkmicSei(seiTag(gameLink(),100,0,4,suffix))[0];
    assert.equal(frame.channel,'7703214997949912100');
    assert.deepEqual(frame.participants.map(p=>[p.linkId,p.x,p.y,p.w,p.h]),[
      ['host_camera',0,2/3,.5,1/3],['guest_camera',.5,2/3,.5,1/3]]);
  }
  for(const suffix of ['\0garbage','\0{}','x'])assert.deepEqual(linkmicSei(seiTag(gameLink(),100,0,4,suffix)),[]);
});
test('previously scanned NUL-terminated sources are reindexed and retain resolved names',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-nul-')),store=new Store(root);
  const index=new LinkmicIndex(store);t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession({status:'finished'}),file=path.join(root,'sample.flv');
  const bytes=Buffer.concat([FLV_HEADER,seiTag(gameLink(),100,1,4,'\0'),seiTag(gameLink(),100,2,4,'\0')]);
  await fs.writeFile(file,bytes);const source=store.addSource(session.id,file,0,undefined,true);
  store.run('UPDATE sources SET duration=10,closed=2 WHERE id=?',source.id);
  store.setting('linkmic-index:'+source.id,{version:5,pos:bytes.length,seq:0,lengthSize:4,mode:'original',complete:true});
  for(const [link,id,name] of [['host_camera','101','本房主播'],['guest_camera','102','连麦嘉宾']])
    store.run('INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?)',source.id,'7703214997949912100',link,id,name);
  await index.ensure(session.id);const events=index.events(session.id);
  assert.equal(events.length,1);assert.deepEqual(events[0].participants.map(p=>p.name),['本房主播','连麦嘉宾']);
  assert.match(linkmicAss(events,1920,1620),/本房主播/);assert.match(linkmicAss(events,1920,1620),/连麦嘉宾/);
});
test('audience floating seats match native bottom-up positions and preserve host and guest IDs',()=>{
  const people=linkmicSei(seiTag(audience(),100))[0].participants;
  assert.equal(people.length,3);
  assert.deepEqual(people[0],{x:0,y:0,w:1,h:1,linkId:'1_owner',main:true});
  const voice=people.find(p=>p.linkId==='2_voice'),video=people.find(p=>p.linkId==='3_video');
  assert.equal(voice.audioOnly,true);assert.equal(video.audioOnly,undefined);
  const cameraOn=linkmicSei(seiTag(audience({grids:[{p:1,type:1,uid_str:'2_voice'}]}),100))[0].participants.find(p=>p.linkId==='2_voice');
  assert.equal(cameraOn.audioOnly,undefined,'opening the camera removes the avatar card');
  assert.equal(video.x,.761);assert.equal(video.w,.205);
  assert.ok(Math.abs(video.y+video.h-(1-.149*360/640))<1e-9);
  assert.ok(Math.abs(voice.y+voice.h-video.y)<1e-9);
  assert.equal(participantName({...video,id:'52934577773'}),'ID 52934577773');
  for(const changes of [{hide_micseat:1},{ui_layout:99},{interactive_scene:1},{canvas:{width:0,height:640}}])
    assert.equal(linkmicSei(seiTag(audience(changes),100))[0].participants.length,0);
  const six=Array.from({length:6},(_,p)=>({p,uid_str:'seat_'+p,type:2}));
  assert.equal(linkmicSei(seiTag(audience({grids:six}),100))[0].participants.length,7,'room anchor is included when only floating guest seats are supplied');
  assert.equal(linkmicSei(seiTag(audience({grids:[six[0],six[0]]}),100))[0].participants.length,0);
  assert.equal(linkmicSei(seiTag(audience({grids:[{...six[0],visible:0}]}),100))[0].participants.length,0);
});

test('Douyin focused large picture follows exact identity and host labels use their own bottom-left corner',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-focus-')),store=new Store(root);
  const session=store.createSession({status:'finished'}),file=path.join(root,'sample.flv');
  const guestOnly=audience({grids:[{p:0,type:1,uid_str:'3_video'}]});
  const guestMain=audience({grids:[{p:-1,type:1,uid_str:'3_video'},{p:0,type:1,uid_str:'1_owner'}]});
  const unknownMain=audience({anchor_interact_info:{layout_type:1,focus_id:'unknown_guest'},grids:[{p:-1,type:1,uid_str:'unknown_guest'}]});
  const focused={app_data:JSON.stringify({channel_id:'998',ver:6,anchor_interact_info:{layout_type:1,focus_id:'3_video'},grids:[
    {uid_str:'1_owner',x:.8,y:0,w:.2,h:.3},{uid_str:'3_video',x:0,y:0,w:.8,h:1}]})};
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,seiTag(guestOnly,100,1),seiTag(guestMain,100,2),seiTag(unknownMain,100,3),seiTag(audience({grids:[]}),100,4),seiTag(focused,100,5)]));
  const source=store.addSource(session.id,file);store.run('UPDATE sources SET duration=8,closed=2 WHERE id=?',source.id);
  store.setting('linkmic-owner:'+source.id,{id:'101',name:'本房主播',roomId:'998'});
  for(const [linkId,id,name]of [['1_owner','101','名单中的旧称呼'],['3_video','103','大屏嘉宾']])store.run('INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?)',source.id,'998',linkId,id,name);
  const index=new LinkmicIndex(store,{resolver:{linkmic(){throw new Error('Archived recordings must not use a current roster');}}});
  t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});await index.ensure(session.id);
  const events=index.events(session.id),at=time=>labelsAt(events,time);
  assert.equal(at(1.5).find(p=>p.owner).name,'本房主播');assert.equal(at(1.5).find(p=>p.owner).labelAlign,'left');
  assert.equal(at(2.5).find(p=>p.main).name,'大屏嘉宾');assert.equal(at(2.5).find(p=>p.main).owner,undefined);assert.equal(at(2.5).find(p=>p.main).labelAlign,'left');
  assert.equal(at(2.5).find(p=>p.owner).name,'本房主播');
  assert.equal(participantName(at(3.5)[0]),'连麦 unknown_guest','unknown main picture never inherits the local anchor name');
  assert.deepEqual(at(4.5),[]);
  assert.equal(at(5.5).find(p=>p.main).id,'103','focus is matched by ID rather than array order');
  const g=labelGeometry(at(5.5).find(p=>p.main),640,360);assert.equal(g.align,'left');assert.ok(g.x<10&&g.y>350);
  const ass=linkmicAss(events,640,360);assert.match(ass,/\\an1\\pos/);assert.match(ass,/大屏嘉宾/);
});
// Public portrait stream captured on 2026-11-02: p=6 is the enlarged guest,
// while the host occupies p=2. Roster/list order is deliberately different.
test('portrait p=6 main follows guest swaps and return to host; v6 cached host labels are replaced',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-main-seat-')),store=new Store(root);
  const index=new LinkmicIndex(store);t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession({status:'finished'}),file=path.join(root,'sample.flv');
  const scene=main=>audience({style:4,sub_scene:8,grids:[
    {p:2,type:1,uid_str:'1_owner'},{p:1,type:2,uid_str:'2_voice'},
    {p:6,type:1,uid_str:main},{p:0,type:2,uid_str:'4_voice'}]});
  const samples=[scene('3_video'),scene('5_guest'),scene('unknown_guest'),
    audience({grids:[{p:6,type:1,uid_str:'1_owner'},{p:0,type:1,uid_str:'3_video'}]}),audience({grids:[]})];
  const bytes=Buffer.concat([FLV_HEADER,...samples.map((value,i)=>seiTag(value,100,i+1,4,'\0'))]);
  await fs.writeFile(file,bytes);const source=store.addSource(session.id,file);
  store.run('UPDATE sources SET duration=8,closed=2 WHERE id=?',source.id);
  store.setting('linkmic-owner:'+source.id,{id:'101',name:'本房主播',roomId:'998'});
  for(const [linkId,id,name]of [['5_guest','105','另一位嘉宾'],['1_owner','101','本房主播'],['3_video','103','大屏嘉宾']])
    store.run('INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?)',source.id,'998',linkId,id,name);
  store.setting('linkmic-index:'+source.id,{version:6,pos:bytes.length,seq:0,lengthSize:4,mode:'original',complete:true});
  store.run('INSERT INTO linkmic_frames VALUES(?,?,?,?)',source.id,1,8,JSON.stringify({platform:'douyin',channel:'998',participants:[{x:0,y:0,w:1,h:1,linkId:'',owner:true,main:true}]}));
  await index.ensure(session.id);const events=index.events(session.id),at=time=>labelsAt(events,time);
  for(const [time,name]of [[1.5,'大屏嘉宾'],[2,'另一位嘉宾'],[4,'本房主播']]){
    const main=at(time).filter(p=>p.main);assert.equal(main.length,1);assert.equal(main[0].name,name);
    assert.equal(main[0].labelAlign,'left');assert.deepEqual([main[0].x,main[0].y,main[0].w,main[0].h],[0,0,1,1]);
  }
  assert.equal(at(1.5).filter(p=>p.name==='本房主播').length,1,'host appears only in its actual small seat');
  assert.equal(at(1.5).find(p=>p.owner).main,undefined);
  assert.equal(participantName(at(3).find(p=>p.main)),'连麦 unknown_guest');
  assert.equal(at(3).find(p=>p.main).owner,undefined);
  assert.deepEqual(at(5),[],'leaving linkmic clears all names at the event boundary');
  assert.doesNotMatch(linkmicAss(events,360,640,{from:1,to:2}),/另一位嘉宾/);
  assert.match(linkmicAss(events,360,640,{from:2,to:3}),/另一位嘉宾/);
  assert.doesNotMatch(linkmicAss(events,360,640,{from:2,to:3}),/大屏嘉宾/);
});
test('invalid or conflicting main seats never manufacture a host label',()=>{
  const host={p:2,type:1,uid_str:'1_owner'},main={p:6,type:1,uid_str:'3_video'};
  for(const grids of [
    [host,{...main,visible:0}],[host,{...main,uid_str:''}],[host,main,{...main,uid_str:'5_guest'}],
    [host,main,{p:-1,type:1,uid_str:'5_guest'}],[host,{...main,p:7}],
    [host,main,{p:0,type:1,uid_str:'3_video'}],
  ]){
    const people=linkmicSei(seiTag(audience({grids}),100))[0].participants;
    assert.equal(people.filter(p=>p.main||p.owner).length,0,'invalid explicit main cannot fall back to the local anchor');
  }
  const focused=linkmicSei(seiTag(audience({anchor_interact_info:{layout_type:1,focus_id:'5_guest'},grids:[host,main]}),100))[0].participants;
  assert.equal(focused.some(p=>p.main),false,'conflicting focus and main-seat IDs are ambiguous');
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
test('name and camera timelines retain independent expiry, changes and clears across indexing restarts',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-sei-timelines-')),store=new Store(root);
  const session=store.createSession({status:'finished'}),file=path.join(root,'sample.flv');
  const both=()=>({...bili(),MULTI_SCREEN:{crop_info:[
    {position:0,x:0,y:.25,cx:.5,cy:.5},{position:1,x:.75,y:.25,cx:.25,cy:1/3}]}});
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,...[1,2,8,15].map(time=>seiTag(both(),5,time))]));
  const source=store.addSource(session.id,file,10,undefined,true);
  store.run('UPDATE sources SET duration=60 WHERE id=?',source.id);
  let index=new LinkmicIndex(store);
  t.after(async()=>{await index.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  await index.ensure(session.id);
  assert.deepEqual(index.events(session.id).map(e=>[e.time,e.end]),[[11,24],[25,31]],'six seconds renews names; seven seconds starts a new interval');
  assert.deepEqual(index.cameraEvents(session.id).map(e=>[e.time,e.end]),[[11,35]],'the camera retains its ten-second window');
  await index.close();
  const changed=bili();changed.LIVE_MULTI_VIDEO_LINK.members[0].uname='更换后的嘉宾';
  const cleared=bili();cleared.LIVE_MULTI_VIDEO_LINK.session_status=0;
  await fs.appendFile(file,Buffer.concat([seiTag(changed,5,16),seiTag({MULTI_SCREEN:{crop_info:[]}},5,17),
    seiTag(cleared,5,18),seiTag({unrelated:true},5,19),seiTag(both(),5,29)]));
  store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
  index=new LinkmicIndex(store);await index.ensure(session.id);
  const events=index.events(session.id);
  assert.deepEqual(events.map(e=>[e.time,e.end,e.participants.find(p=>p.id==='103')?.name||'']),
    [[11,24,'嘉宾乙'],[25,26,'嘉宾乙'],[26,28,'更换后的嘉宾'],[28,34,''],[39,45,'嘉宾乙']]);
  assert.deepEqual(index.cameraEvents(session.id).map(e=>[e.time,e.end]),[[11,27],[39,49]],'name changes leave the camera active until its own clear');
  assert.equal(labelsAt(events,27.5).length,3,'clearing the camera leaves the names active');
  assert.equal(labelsAt(events,28).length,0,'the explicit name clear still takes effect');
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
  assert.deepEqual(labels,['连麦 1_owner','ID 102','视频用户'],'an unresolved explicit main ID must not inherit the host identity');
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
