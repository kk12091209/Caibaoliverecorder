import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinResolver} from '../server/douyin-room.js';
import {DouyinUserDiscovery} from '../server/douyin-user-discovery.js';

const roomId='7705245817595562767',anchorId='103228519581',uid='3340738536156355';
const args={roomId,anchorId,channel:roomId,version:15};
const position=(userId=uid,extra={})=>({position:2,status:1,user:{user_id:userId,nickname:'连线嘉宾',
  linkmic_id_str:'2_guest',linker_room_id:roomId,avatar_thumb_url:'https://p3.douyinpic.com/avatar.jpeg'},...extra});
const roster=(positions=[position()],owner=anchorId)=>({status_code:0,data:{basic:{scene:20,ui_layout:120,owner_user_id:owner,positions}}});
function fixture(v2={status_code:31001,data:{message:'linkmic has closed'}},v3=roster()){
  const calls=[];
  const resolver=new DouyinResolver({request:async(input,options)=>{
    const url=new URL(input);calls.push({url,options});
    return new Response(JSON.stringify(url.pathname.endsWith('/v3/')?v3:v2));
  }});
  resolver.visitor={cookie:'ttwid=anonymous',expires:Date.now()+60000};
  return {resolver,calls};
}

test('new video-link rooms recover the exact occupied guest from v3 when v2 reports closed',async()=>{
  const {resolver,calls}=fixture();
  assert.deepEqual(await resolver.linkmic(args),[{linkId:'2_guest',id:uid,name:'连线嘉宾',avatarUrl:'https://p3.douyinpic.com/avatar.jpeg'}]);
  assert.deepEqual(calls.map(({url})=>url.pathname),['/webcast/linkmic_audience/list/v2/','/webcast/linkmic_audience/list/v3/']);
  for(const {url,options} of calls){
    assert.equal(url.origin,'https://live.douyin.com');assert.equal(url.searchParams.get('room_id'),roomId);
    assert.equal(url.searchParams.get('anchor_id'),anchorId);assert.ok(url.searchParams.get('a_bogus'));
    assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,'ttwid=anonymous');
  }
});

test('v3 numeric uint64 identities stay exact; empty seats, inactive guests and other rooms never confirm membership',async()=>{
  const raw=JSON.stringify(roster([position(),position(uid,{status:0}),position('88',{user:{...position().user,linker_room_id:'999'}}),{status:0}]))
    .replace('"user_id":"'+uid+'"','"user_id":'+uid);
  const {resolver}=fixture();const request=resolver.request;
  resolver.request=async(url,options)=>new URL(url).pathname.endsWith('/v3/')?new Response(raw):request(url,options);
  assert.deepEqual((await resolver.linkmic(args)).map(p=>p.id),[uid]);
  const large='12345678901234567890';
  resolver.request=async(url,options)=>new URL(url).pathname.endsWith('/v3/')?
    new Response(JSON.stringify(roster([position(large)])).replace('"user_id":"'+large+'"','"user_id":'+large)):request(url,options);
  assert.equal((await resolver.linkmic(args))[0].id,large);
});

test('v3 requires the exact host and a valid successful roster, without guessing from names',async()=>{
  for(const v3 of [roster([position()],'999'),roster([position()],''),{status_code:0,data:{basic:{owner_user_id:anchorId}}},
    {...roster(),status_code:31001},roster([position('bad-id')])]){
    const {resolver}=fixture(undefined,v3);
    if(v3.data?.basic?.positions?.[0]?.user?.user_id==='bad-id')assert.deepEqual(await resolver.linkmic(args),[]);
    else await assert.rejects(resolver.linkmic(args),/名单暂时不可用/);
  }
});

test('successful legacy audience and PK rosters keep their existing endpoint and interpretation',async()=>{
  const old={status_code:0,data:{user:[{linkmic_id_str:'legacy',user:{id_str:uid,nickname:'旧协议'}}]}};
  for(const version of [15,2,6]){
    const {resolver,calls}=fixture(old);
    assert.equal((await resolver.linkmic({...args,version}))[0].id,uid);assert.equal(calls.length,1);
    assert.equal(calls[0].url.pathname,version===15?'/webcast/linkmic_audience/list/v2/':'/webcast/linkmic/list/');
  }
  const {resolver,calls}=fixture();await assert.rejects(resolver.linkmic({...args,version:6}));assert.equal(calls.length,1);
});

test('network, authentication, malformed responses and rate limits do not fan out into another roster request',async()=>{
  for(const body of [{status_code:429},{status_code:403},{status_code:0,data:{}},null]){
    const {resolver,calls}=fixture(body);await assert.rejects(resolver.linkmic(args));assert.equal(calls.length,1);
  }
  for(const response of [()=>{throw new Error('network failed');},()=>new Response('limited',{status:429}),()=>new Response('{')]){
    const {resolver}=fixture();let calls=0;resolver.request=async()=>{calls++;return response();};
    await assert.rejects(resolver.linkmic(args));assert.equal(calls,1);
  }
  const {resolver}=fixture(),abort=new AbortController();let calls=0;
  resolver.request=async()=>{calls++;abort.abort();return new Response(JSON.stringify({status_code:31001}));};
  await assert.rejects(resolver.linkmic({...args,signal:abort.signal}),{name:'AbortError'});assert.equal(calls,1);
});

test('profile-follow discovery confirms a new-mode guest only after exact current-room membership verification',async()=>{
  let members=[position()],currentRoom=roomId;
  const {resolver}=fixture(),request=resolver.request;
  resolver.request=async(url,options)=>new URL(url).pathname.endsWith('/v3/')?new Response(JSON.stringify(roster(members))):request(url,options);
  resolver.room=async()=>({webRid:'840671433335',roomId:currentRoom,ownerId:anchorId,streaming:true,stream:{url:'fixture'}});
  const discovery=new DouyinUserDiscovery({resolver,request:async()=>new Response(null,{status:302,headers:{location:'https://live.douyin.com/840671433335'}})});
  discovery.json=async()=>({status_code:0,data:[{user_live:[{user_id_str:uid,live_status:2,room_id_str:roomId}]}]});
  assert.equal((await discovery.observe(uid)).state,'guest-confirmed');
  members=[position('999')];assert.equal((await discovery.observe(uid)).state,'unknown');
  members=[position(uid,{status:0})];assert.equal((await discovery.observe(uid)).state,'unknown');
  members=[position()];currentRoom='999';assert.equal((await discovery.observe(uid)).state,'unknown');
  currentRoom=roomId;resolver.room=async()=>({roomId,ownerId:uid,streaming:true,stream:{url:'fixture'}});
  resolver.linkmic=async()=>assert.fail('self live does not require a guest roster');
  assert.equal((await discovery.observe(uid)).state,'self-live');
});
