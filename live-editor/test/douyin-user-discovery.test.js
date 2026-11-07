import test from 'node:test';
import assert from 'node:assert/strict';
import {decimal,selectUserRoom,profileSecUid,DouyinUserDiscovery} from '../server/douyin-user-discovery.js';
const uid='1893817376060736',roomId='7703009634369440563';
const response=(users,status=0)=>({status_code:status,data:[{user_live:users}]});
const user=(extra={})=>({user_id_str:uid,live_status:2,room_id_str:roomId,...extra});
test('preserves 64-bit room IDs and rejects rounded numbers',()=>{
  assert.equal(decimal(roomId),roomId);assert.equal(decimal(Number(roomId)),'');
  assert.equal(selectUserRoom(response([user()]),uid).roomId,roomId);
});
test('never adopts another user returned in a batch',()=>{
  assert.equal(selectUserRoom(response([user({user_id_str:'999'})]),uid).state,'unknown');
});
test('duplicate matching results are fine, conflicting rooms are unknown',()=>{
  assert.equal(selectUserRoom(response([user(),user()]),uid).state,'candidate');
  assert.equal(selectUserRoom(response([user(),user({room_id_str:'123'})]),uid).state,'unknown');
});
test('errors, missing targets and unknown status codes do not imply offline',()=>{
  for(const body of [response([],1),response([]),response([user({live_status:99})]),{},null])assert.equal(selectUserRoom(body,uid).state,'unknown');
  assert.equal(selectUserRoom(response([user({live_status:0,room_id_str:'0'})]),uid).state,'offline-observation');
});
test('invalid live room IDs do not become candidates',()=>{
  for(const value of ['0','https://example.com','',Number(roomId)])assert.equal(selectUserRoom(response([user({room_id_str:value})]),uid).state,'unknown');
});

test('personal links expand only through approved HTTPS hosts and cannot become room or credential URLs',async()=>{
 const calls=[];const request=async url=>{calls.push(String(url));return new Response(null,{status:302,headers:{location:'https://www.douyin.com/user/SEC_USER_EXAMPLE'}});};
 assert.equal(await profileSecUid('长按复制 https://v.douyin.com/example/ 查看用户',{request}),'SEC_USER_EXAMPLE');assert.equal(calls.length,1);
 for(const link of ['https://www.douyin.com/video/123','https://live.douyin.com/123','https://user:pass@www.douyin.com/user/SEC_USER_EXAMPLE','http://www.douyin.com/user/SEC_USER_EXAMPLE'])await assert.rejects(profileSecUid(link,{request}));
 await assert.rejects(profileSecUid('https://v.douyin.com/example/',{request:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}));
});

test('mobile profile cards accept whole share text and use the target in the official path, not tracking users',async()=>{
 const secUid='MS4wLjABAAAAVLF99ZRQYIftcYr6Sx_mQGtdq2zM-09_2E7lYDc0gK4';
 const share=`https://www.iesdouyin.com/share/user/${secUid}?sec_uid=${secUid}&from_aid=1128&ecom_share_track_params=${encodeURIComponent(JSON.stringify({secuid:'A_DIFFERENT_SHARER'}))}`;
 const calls=[];const request=async(url,options)=>{calls.push(String(url));assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:share}});};
 const input='3- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/EJ0roLp277M/ 9@2.com :7pm';
 assert.equal(await profileSecUid(input,{request}),secUid);assert.deepEqual(calls,['https://v.douyin.com/EJ0roLp277M/']);
 assert.equal(await profileSecUid(share,{request}),secUid);assert.equal(calls.length,1);
 assert.equal(await profileSecUid(`https://www.iesdouyin.com/share/user/${secUid}/`,{request}),secUid);
 const discovery=new DouyinUserDiscovery({request});discovery.json=async(endpoint,params)=>{assert.equal(params.sec_user_id,secUid);return {status_code:0,user:{uid,sec_uid:secUid,nickname:'名片目标'}};};
 assert.deepEqual(await discovery.identity(input),{uid,secUid,name:'名片目标',profile:`https://www.douyin.com/user/${secUid}`});
 discovery.json=async()=>({status_code:0,user:{uid,sec_uid:'A_DIFFERENT_USER'}});
 await assert.rejects(discovery.identity(input),/无法核验/);
});

test('mobile card support still rejects foreign hosts, non-profile paths and conflicting identity hints',async()=>{
 const secUid='SEC_USER_EXAMPLE',request=async()=>{assert.fail('invalid terminal share pages must never be fetched');};
 for(const link of [
  `http://www.iesdouyin.com/share/user/${secUid}`,
  `https://www.iesdouyin.com.evil.test/share/user/${secUid}`,
  `https://user:pass@www.iesdouyin.com/share/user/${secUid}`,
  `https://www.iesdouyin.com:444/share/user/${secUid}`,
  `https://www.iesdouyin.com/share/video/123?sec_uid=${secUid}`,
  `https://www.iesdouyin.com/share/user/?sec_uid=${secUid}`,
  `https://www.iesdouyin.com/share/user/${secUid}?sec_uid=ANOTHER_USER`,
  `https://www.iesdouyin.com/share/user/${secUid}?sec_uid=${secUid}&sec_uid=${secUid}`,
 ])await assert.rejects(profileSecUid(link,{request}));
 await assert.rejects(profileSecUid('https://v.douyin.com/loop/',{request:async()=>new Response(null,{status:302,headers:{location:'/loop/'}})}),/跳转过多/);
});

test('discovery verifies the exact current room and stable member UID; missing roster and self live remain separate',async()=>{
 let metadata={webRid:'123',roomId,ownerId:'88',streaming:true,stream:{url:'https://pull-test.douyincdn.com/fixture.flv'}},members=[{id:uid,name:'改过昵称'}];
 const discovery=new DouyinUserDiscovery({resolver:{room:async()=>metadata,linkmic:async()=>members},request:async()=>new Response(null,{status:302,headers:{location:'https://live.douyin.com/123'}})});discovery.json=async()=>response([user()]);
 assert.equal((await discovery.observe(uid)).state,'guest-confirmed');members=[{id:'999',name:'目标昵称'}];assert.equal((await discovery.observe(uid)).state,'unknown');members=[];assert.equal((await discovery.observe(uid)).state,'unknown');
 metadata={...metadata,roomId:'222'};assert.equal((await discovery.observe(uid)).state,'unknown');metadata={...metadata,roomId,ownerId:uid};assert.equal((await discovery.observe(uid)).state,'self-live');
});

test('monitoring a room resolves its owner UID and the same profile resolves to that identity',async()=>{
 const metadata={webRid:'123',ownerId:uid,name:'主播A'},secUid='SEC_USER_EXAMPLE';
 const discovery=new DouyinUserDiscovery({resolver:{room:async webRid=>{assert.equal(webRid,'123');return metadata;}},request:async()=>new Response(null,{status:302,headers:{location:'https://www.douyin.com/user/'+secUid}})});
 discovery.json=async()=>({status_code:0,user:{uid,sec_uid:secUid,nickname:'主播A'}});
 assert.equal((await discovery.monitorIdentity('https://live.douyin.com/123')).uid,uid);
 assert.equal((await discovery.monitorIdentity('分享 https://v.douyin.com/profile/ 查看TA')).uid,uid);
 metadata.ownerId='';await assert.rejects(discovery.monitorIdentity('https://live.douyin.com/123'),/无法核验/);
});

test('known own room is checked by exact owner UID; offline or another owner cannot suppress guest discovery',async()=>{
 let metadata={webRid:'123',roomId,ownerId:uid,name:'本人',streaming:true,stream:{url:'fixture'}};
 const discovery=new DouyinUserDiscovery({resolver:{room:async()=>metadata}});let checks=0;
 discovery.json=async()=>{checks++;return response([user({live_status:0,room_id_str:'0'})]);};
 assert.equal((await discovery.observe(uid,{ownWebRid:'123'})).state,'self-live');assert.equal(checks,0);
 metadata={...metadata,ownerId:'999'};assert.equal((await discovery.observe(uid,{ownWebRid:'123'})).state,'offline-observation');assert.equal(checks,1);
 metadata={...metadata,ownerId:uid,streaming:false};assert.equal((await discovery.observe(uid,{ownWebRid:'123'})).state,'offline-observation');assert.equal(checks,2);
});

test('missing user status preserves verified own-room offline evidence only',async()=>{
 const ownWebRid='123';
 let metadata={webRid:ownWebRid,roomId,ownerId:uid,streaming:false};
 const discovery=new DouyinUserDiscovery({resolver:{room:async()=>metadata}});
 discovery.json=async()=>response([]);
 assert.deepEqual(await discovery.observe(uid,{ownWebRid}),{
  state:'unknown',reason:'状态接口未返回目标用户',ownOffline:{webRid:ownWebRid,roomId},
 });
 for(const changed of [{ownerId:'999'},{webRid:'456'},{streaming:true}]){
  const original=metadata;metadata={...metadata,...changed};
  assert.equal((await discovery.observe(uid,{ownWebRid})).ownOffline,undefined);
  metadata=original;
 }
});
