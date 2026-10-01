import test from 'node:test';
import assert from 'node:assert/strict';
import {signChatDigest,signChatUrl,signRoomQuery} from '../server/douyin-signing.js';
test('native chat signing matches upstream differential JavaScript vectors exactly',()=>{
 assert.equal(signChatDigest('704f436b2558b0d7a1c7e758527dd8f1',{sequence:1,flag:true,payloadRandom:63,keyRandom:63}),'6pt0VC0aRZDP7n07');
 assert.equal(signChatDigest('704f436b2558b0d7a1c7e758527dd8f1',{sequence:0,flag:false,payloadRandom:0,keyRandom:6}),'fD+evFuzasjOC8Uu');
 assert.throws(()=>signChatDigest('invalid'),/无效/);
 assert.equal(signChatUrl('https://live.douyin.com/?room_id=7691637058724547364').length,16);
});
test('room signatures stay deterministic under fixed clock/random and change with the room query',()=>{
 const options={now:1790850000000,random:()=>12345};
 const first=signRoomQuery('web_rid=123','Mozilla/5.0',options);assert.equal(first,signRoomQuery('web_rid=123','Mozilla/5.0',options));
 assert.notEqual(first,signRoomQuery('web_rid=124','Mozilla/5.0',options));assert.ok(first.length>100);
});
