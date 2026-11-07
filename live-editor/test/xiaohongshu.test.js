import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/store.js';
import {Ingestor,FLV_HEADER} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';
import {XiaohongshuResolver,parseXiaohongshuState,xiaohongshuMetadata,safeXiaohongshuStream,safeXiaohongshuRedirect} from '../server/xiaohongshu-room.js';
import {XiaohongshuPlatform} from '../server/xiaohongshu-platform.js';
import {XiaohongshuH5Chat as XiaohongshuChat} from '../server/xiaohongshu-h5-chat.js';
import {MultiPlatformRecorder} from '../server/multi-platform-recorder.js';

const uid='1234567890abcdef12345678',roomId='570530566834076942';
const media='https://live-source-play-hw.xhscdn.com/live/'+roomId+'.flv';
const state=()=>({liveStream:{liveStatus:'success',roomData:{
  hostInfo:{nickName:'本地测试主播'},roomInfo:{
    roomId,status:2,roomTitle:'本地录制',monetizeType:0,joinLimitTypes:[0],
    deeplink:'xhsdiscover://live_audience?room_id='+roomId+'&host_id='+uid,
    pullConfig:JSON.stringify({h264:[{master_url:media,quality_type:'HD'}],h265:[]}),
  },
}}});
const html=value=>'<script>window.__INITIAL_STATE__='+JSON.stringify(value)+'</script>';
const wait=async check=>{
  for(let n=0;n<200;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('operation did not settle');
};

test('XHS hydration parsing preserves uint64 identity and quoted undefined without executing scripts',()=>{
  const raw=html(state()).replace('"'+roomId+'"',''+roomId).replace('"本地录制"','"undefined 是正文"');
  const parsed=parseXiaohongshuState(raw.replace('"hostInfo":','"optional":undefined,"hostInfo":'));
  assert.equal(parsed.liveStream.roomData.roomInfo.roomId,roomId);
  assert.equal(parsed.liveStream.roomData.roomInfo.roomTitle,'undefined 是正文');
  assert.equal(xiaohongshuMetadata(parsed,roomId).ownerId,uid);
  assert.throws(()=>parseXiaohongshuState('<script>window.__INITIAL_STATE__=(()=>process.exit())()</script>'));
});

test('share/profile routes verify exact room and owner, reject foreign redirects and preserve profile IDs separately from red IDs',async()=>{
  const calls=[];
  const resolver=new XiaohongshuResolver({request:async input=>{
    const url=new URL(input);calls.push(url);
    if(url.hostname==='xhslink.com')return new Response(null,{status:302,headers:{location:'https://www.xiaohongshu.com/livestream/dynpathABC/'+roomId+'?host_id='+uid}});
    if(url.hostname==='xhslink.cn')return new Response(null,{status:302,headers:{location:'https://www.xiaohongshu.com/user/profile/'+uid+'?xsec_token=share-only'}});
    return new Response(html(url.pathname.includes('/profile/')?{profile:{userInfo:{nickname:'本地测试主播',id:'123456789'}}}:state()));
  }});
  assert.equal((await resolver.resolve('复制 https://xhslink.com/o/example 观看')).metadata.roomId,roomId);
  assert.equal((await resolver.resolve('主页 https://xhslink.cn/o/profile')).uid,uid);
  for(const url of ['https://www.xiaohongshu.com/livestream/'+roomId,'https://www.xiaohongshu.com/hina/livestream/'+roomId+'/123']){
    assert.equal((await resolver.resolve(url)).metadata.ownerId,uid);
  }
  resolver.request=async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});
  await assert.rejects(resolver.resolve('https://xhslink.com/o/example'),/官方/);
  for(const mutate of [
    value=>{value.liveStream.roomData.roomInfo.roomId='999';},
    value=>{value.liveStream.roomData.roomInfo.monetizeType=1;},
    value=>{value.liveStream.roomData.roomInfo.joinLimitTypes=[2];},
    value=>{value.liveStream.roomData.roomInfo.status=99;},
    value=>{value.liveStream.roomData.roomInfo.deeplink='xhsdiscover://live_audience?room_id=1&host_id='+uid;},
  ]){
    const value=state();mutate(value);assert.throws(()=>xiaohongshuMetadata(value,roomId));
  }
  assert.ok(calls.length>0);
});

test('media URL boundaries accept only the matching platform CDN and keep redirects in the same broadcast',()=>{
  assert.equal(safeXiaohongshuStream(media),media);
  for(const url of [
    'https://xhscdn.com.evil.test/live/'+roomId+'.flv',
    'https://127.0.0.1/live/'+roomId+'.flv',
    'https://user:pass@live-play.xhscdn.com/live/'+roomId+'.flv',
    'https://live-play.xhscdn.com:8000/live/'+roomId+'.flv',
  ])assert.equal(safeXiaohongshuStream(url),'');
  assert.equal(safeXiaohongshuRedirect('https://live-play.xhscdn.com/live/999.flv',media),'');
  assert.equal(safeXiaohongshuRedirect(media+'?uid=visitor',media),media+'?uid=visitor');
});

test('H5 comment polling persists bounded unique messages, preserves the cursor on failure and closes in-flight work',async()=>{
  let now=100000,calls=0,bytes=[],client;
  const chat=new XiaohongshuChat({now:()=>now,request:async(_url,options)=>{
    calls++;assert.equal(options.headers.Cookie,undefined);
    return Response.json({success:true,data:{endTimestamp:now+10,nextRequestInterval:30000,
      comments:[{profile:{userId:uid,nickname:'观众'},desc:'测试弹幕'},{profile:{userId:uid,nickname:'观众'},desc:'测试弹幕'}]}});
  }});
  chat.start('source',{roomId,sourceStart:99000},{write:async batch=>{bytes.push(...batch.messages);},status(){}});
  await wait(()=>chat.snapshot('source')?.connection==='connected');
  client=chat.clients.get('source');clearTimeout(client.timer);
  assert.equal(bytes.length,2,'identical text can be two separate comments');
  const cursor=client.cursor;
  chat.request=async()=>new Response('restricted',{status:406});
  now+=5000;
  await chat.poll('source',client);
  assert.equal(client.cursor,cursor);
  assert.match(chat.snapshot('source').error,/访问受限/);
  assert.equal(calls,1);
  await chat.close();
  assert.equal(chat.clients.size,0);
});

test('XHS shares and matching profiles coalesce while recording, stop remains stopped, and originals index under their own platform',async t=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'xhs-recording-')),store=new Store(root);
  const resolver=new XiaohongshuResolver(),controls=[];
  resolver.resolve=async input=>input==='profile'?{kind:'profile',uid,name:'本地测试主播'}:{kind:'room',uid,name:'本地测试主播',metadata:xiaohongshuMetadata(state(),roomId)};
  resolver.room=async()=>xiaohongshuMetadata(state(),roomId);
  const adapter=new XiaohongshuPlatform(store,{xiaohongshu:{resolver,pollMs:60000,chat:{start(){},stop:async()=>{},close:async()=>{}},request:async(_url,{signal,headers})=>{
    assert.equal(headers.Cookie,undefined);
    return new Response(new ReadableStream({start(controller){
      controls.push(controller);controller.enqueue(Buffer.concat([FLV_HEADER,flvTag(9,0,24,{header:true}),flvTag(8,0,8,{header:true}),flvTag(9,0,24,{key:true}),flvTag(9,1000,24,{key:true})]));
      signal.addEventListener('abort',()=>controller.close(),{once:true});
    }}));
  }}});
  t.after(async()=>{await adapter.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  adapter.start();
  await adapter.addAnchor({url:'profile'});
  assert.match(adapter.anchors[0].state,/核验/);
  await adapter.addAnchor({url:'live'});
  await wait(()=>adapter.anchors[0].recording);
  await adapter.addAnchor({url:'profile'});
  assert.equal(adapter.anchors.length,1);assert.equal(controls.length,1);
  const target=adapter.anchors[0];
  await adapter.anchorAction(target.key,'stop',{});
  await adapter.core.poll(true);
  assert.equal(controls.length,1);assert.equal(adapter.anchors[0].enabled,false);
  const session=store.sessions()[0],source=store.sources(session.id)[0],ingest=new Ingestor(store);
  await ingest.tick();await ingest.tick();
  assert.equal(store.setting('xiaohongshu-session:'+session.id).platform,'xiaohongshu');
  assert.equal(store.setting('douyin-session:'+session.id),undefined);
  assert.ok(source.path.includes(path.join('originals','xiaohongshu')));
  const coordinator=new MultiPlatformRecorder(store,{executable:'',xiaohongshu:{resolver,chat:{close:async()=>{}}}});
  assert.equal(coordinator.materialOrigins([session])[0].platform,'xiaohongshu');
  await coordinator.close();
});

test('late XHS share resolution cannot undo a newer stop, and replacement broadcasts close the previous room',async t=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'xhs-intent-')),store=new Store(root);
  let release;
  const oldMetadata={...xiaohongshuMetadata(state(),roomId),streaming:false,stream:null};
  const nextRoom='570530566834076943';
  const nextMetadata={...oldMetadata,roomId:nextRoom,webRid:nextRoom};
  const resolver={
    resolve:async input=>input==='delayed'?new Promise(resolve=>{release=()=>resolve({uid,name:'主播',metadata:oldMetadata});}):
      {uid,name:'主播',metadata:input==='next'?nextMetadata:oldMetadata},
    room:async id=>id===nextRoom?nextMetadata:oldMetadata,
  };
  const options={xiaohongshu:{resolver,chat:{close:async()=>{}},pollMs:60000}};
  let adapter=new XiaohongshuPlatform(store,options);
  t.after(async()=>{await adapter.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  adapter.start();
  await adapter.addAnchor({url:'initial'});
  const pending=adapter.addAnchor({url:'delayed'});
  await wait(()=>release);
  await adapter.anchorAction('xiaohongshu-user:'+uid,'stop');
  release();
  await assert.rejects(pending,/操作已变化/);
  assert.equal(adapter.anchors[0].enabled,false);
  await adapter.addAnchor({url:'next'});
  assert.equal(adapter.core.entries.has(roomId),false);
  assert.equal(adapter.core.entries.has(nextRoom),true);
  await adapter.action('xiaohongshu:'+nextRoom,'auto',{enabled:false});
  assert.equal(adapter.anchors[0].enabled,false);
  await adapter.close();
  store.setting('xiaohongshu-rooms',[{webRid:nextRoom,name:'尚未完成停止的旧快照',enabled:true},{webRid:roomId,name:'旧场次',enabled:true}]);
  adapter=new XiaohongshuPlatform(store,options);
  assert.equal(adapter.core.entries.has(roomId),false,'an interrupted broadcast replacement cannot revive an orphan');
  assert.equal(adapter.anchors[0].enabled,false);
  assert.equal(adapter.core.entries.get(nextRoom).enabled,false,'persisted stop wins over a stale writer snapshot');
  assert.equal(adapter.anchors[0].ownWebRid,nextRoom);
  await adapter.anchorAction('xiaohongshu-user:'+uid,'remove',{confirmed:true});
  assert.equal(adapter.anchors.length,0);
});

test('XHS status and sender identity remain platform-scoped throughout list filtering',async()=>{
  const {senderFromXml}=await import('../server/senders.js');
  const {senderFilterFor,validateSenderFilter,matchesSender}=await import('../shared/sender-filter.js');
  const {recorderStatusDetails}=await import('../src/recorder-status.js');
  const {roomAvailable}=await import('../src/room-status.js');
  const identity=senderFromXml({platform:'xiaohongshu',sender_id:uid},{session:'sample'},{setting:()=>undefined});
  assert.deepEqual(identity,{platform:'xiaohongshu',uid});
  const message={senderPlatform:identity.platform,senderId:identity.uid,user:'观众'};
  const filter=validateSenderFilter(senderFilterFor(message));
  assert.equal(matchesSender(message,filter),true);
  assert.equal(matchesSender({...message,senderPlatform:'douyin'},filter),false);
  const recorder={biliOnline:true,douyinOnline:true,xiaohongshuOnline:true};
  assert.equal(roomAvailable({platform:'xiaohongshu'},recorder),true);
  const room={platform:'xiaohongshu',roomId:'xiaohongshu:'+roomId,webRid:roomId,name:'主播',recording:true,
    chatStatus:{connection:'retrying'},chatError:'访问受限'};
  const rows=recorderStatusDetails(recorder,[room],true,[{...room,key:'xiaohongshu-user:'+uid,ownWebRid:roomId}]);
  assert.equal(rows.length,3);
  assert.equal(rows[2].rooms.length,1);
  assert.equal(rows[2].rooms[0].chat,'未连接');
  assert.equal(rows[2].rooms[0].chatFailed,true);
  assert.equal(rows[2].rooms[0].chatHint,'访问受限');
  assert.equal(rows[2].rooms[0].video,'录制中');
});
