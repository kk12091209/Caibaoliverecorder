import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketFrames,clientFrame} from '../server/douyin-websocket.js';
const frame=(data,opcode=2,fin=true)=>{data=Buffer.from(data);return Buffer.concat([Buffer.from([(fin?128:0)|opcode,data.length]),data]);};
test('socket fragmented binary packets tolerate arbitrary TCP boundaries and interleaved ping',()=>{
 const messages=[],pings=[];const parser=new WebSocketFrames({message:b=>messages.push(b.toString()),ping:b=>pings.push(b.toString())});
 const bytes=Buffer.concat([frame('hel',2,false),frame('ping',9),frame('lo',0),frame('world')]);for(const byte of bytes)parser.feed(Buffer.from([byte]));
 assert.deepEqual(messages,['hello','world']);assert.deepEqual(pings,['ping']);assert.equal(parser.bytes,0);
});
test('outgoing frames are masked and long lengths preserve payload bytes',()=>{
 for(const size of [0,10,126,65536]){const payload=Buffer.alloc(size,91),bytes=clientFrame(payload),head=size<126?2:size<=65535?4:10;
  assert.equal(bytes[0],130);assert.ok(bytes[1]&128);const recovered=Buffer.from(bytes.subarray(head+4));for(let i=0;i<size;i++)recovered[i]^=bytes[head+(i&3)];assert.deepEqual(recovered,payload);}
});
test('invalid masked server frames, continuation and oversized fragments close bounded parser',()=>{
 const fresh=()=>new WebSocketFrames({message:()=>{},maximum:10});assert.throws(()=>fresh().feed(Buffer.from([130,129,0,0,0,0,1])),/无效/);
 assert.throws(()=>fresh().feed(frame('x',0)),/顺序/);assert.throws(()=>fresh().feed(frame('12345678901')),/过大/);
 const parser=fresh();parser.feed(frame('123456',2,false));assert.throws(()=>parser.feed(frame('78901',0)),/过大/);
});
