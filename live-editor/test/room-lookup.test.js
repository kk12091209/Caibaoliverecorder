import test from 'node:test';
import assert from 'node:assert/strict';
import {BilibiliRoomResolver,numericRoomId,discoverRoomNumber} from '../server/room-lookup.js';
const notFound=()=>Object.assign(new Error('not found'),{code:'ROOM_NOT_FOUND'});

test('numeric IDs preserve Douyin precision and normalize leading zeros without treating links as numbers',()=>{
 assert.equal(numericRoomId(' 0001016 '),'1016');assert.equal(numericRoomId('7691707893343275816'),'7691707893343275816');
 assert.equal(numericRoomId('https://live.douyin.com/1016'),null);assert.equal(numericRoomId('https://live.bilibili.com/1016'),null);
 for(const input of ['0','000','123456789012345678901'])assert.throws(()=>numericRoomId(input),/有效/);
});

test('Bilibili lookup resolves short room IDs and fetches anchor names without adding rooms or sending cookies',async()=>{
 const calls=[],resolver=new BilibiliRoomResolver({request:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('get_info')?{code:0,data:{room_id:420000,uid:123,live_status:1,title:'测试直播'}}:{code:0,data:{info:{uname:'B站主播'}}}));}});
 const room=await resolver.room('42');assert.deepEqual(room,{roomId:420000,name:'B站主播',title:'测试直播',streaming:true});assert.equal(calls.length,2);
 assert.ok(calls[1].url.endsWith('roomid=420000'));for(const call of calls){assert.equal(call.options.redirect,'error');assert.equal(new Headers(call.options.headers).has('cookie'),false);}
 assert.equal(await resolver.room('57375952448'),null);assert.equal(calls.length,2);
});

test('nonexistent Bilibili room, transient rejection and a missing nickname have different outcomes',async()=>{
 const missing=new BilibiliRoomResolver({request:async()=>new Response(JSON.stringify({code:1,message:'未找到该房间',data:null}))});assert.equal(await missing.room('42'),null);
 const failed=new BilibiliRoomResolver({request:async()=>new Response(JSON.stringify({code:-352,message:'-352'}))});await assert.rejects(failed.room('42'),/暂时无法查询/);
 const unnamed=new BilibiliRoomResolver({request:async url=>new Response(JSON.stringify(url.includes('get_info')?{code:0,data:{room_id:42,uid:123,title:'可辨认的直播标题',live_status:0}}:{code:-352}))});
 assert.equal((await unnamed.room('42')).roomId,42);assert.equal((await unnamed.room('42')).streaming,false);
});

test('lookups run concurrently and return public choices without raw room metadata or visitor secrets',async()=>{
 let entered=0;let release;const waiting=new Promise(resolve=>{release=resolve;});
 const lookup=room=>({async room(){entered++;if(entered===2)release();await waiting;return room;}});
 const result=await discoverRoomNumber('1016',{bilibili:lookup({roomId:1016,name:'B站主播',title:'B站标题',streaming:true,cookie:'private'}),douyin:lookup({webRid:'1016',roomId:'7691707893343275816',name:'抖音主播',title:'抖音标题',streaming:false,cookie:'ttwid=private',stream:{url:'https://signed.private/?token=secret'}})});
 assert.equal(entered,2);assert.deepEqual(result.unavailable,[]);assert.deepEqual(result.candidates.map(room=>room.platform),['bilibili','douyin']);
 assert.equal(result.candidates[1].url,'https://live.douyin.com/1016');assert.equal(result.candidates[0].url,'https://live.bilibili.com/1016');
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('token'),false);
});

test('a transient failure never counts as a nonexistent competing platform',async()=>{
 const bilibili={room:async()=>({roomId:42,name:'B站主播',streaming:false})};
 const absent=await discoverRoomNumber('42',{bilibili,douyin:{room:async()=>{throw notFound();}}});assert.equal(absent.candidates.length,1);assert.deepEqual(absent.unavailable,[]);
 const failed=await discoverRoomNumber('42',{bilibili,douyin:{room:async()=>{throw Error('timeout');}}});assert.equal(failed.candidates.length,1);assert.deepEqual(failed.unavailable,['douyin']);
});

test('Bilibili room response sizes remain bounded',async()=>{
 const resolver=new BilibiliRoomResolver({request:async()=>new Response('x'.repeat(1024*1024+1))});await assert.rejects(resolver.room('42'),/过大/);
});
