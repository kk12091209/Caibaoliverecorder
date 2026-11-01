import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketFrames,clientFrame,openDouyinSocket} from '../server/douyin-websocket.js';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {chatFailure,douyinChatError} from '../server/douyin-chat-status.js';
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

test('actual upgrade path retains safe HTTP status while excluding signed URL and response payload',async t=>{
 t.mock.method(https,'request',()=>{
  const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>request.emit('response',{statusCode:403,destroy(){},body:'private-response'}));return request;
 });
 await assert.rejects(openDouyinSocket('wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?signature=private-signature',{headers:{Cookie:'private-cookie'},onMessage(){}}),error=>{
  assert.deepEqual(chatFailure(error),{reason:'http',stage:'upgrade',code:403});assert.doesNotMatch(error.message,/private/);return true;
 });
});

test('actual upgraded connection classifies invalid frames and explicit receive timeout, closing only once',async t=>{
 const streams=[];
 t.mock.method(https,'request',(_url,{headers})=>{
  const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>{
   const stream=new EventEmitter();Object.assign(stream,{writable:true,writableLength:0,destroy(){this.writable=false;},write(){return true;}});streams.push(stream);
   request.emit('upgrade',{statusCode:101,headers:{'sec-websocket-accept':createHash('sha1').update(headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}},stream,Buffer.alloc(0));
  });return request;
 });
 const reasons=[],open=()=>openDouyinSocket('wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/',{onMessage(){throw new Error('private-protobuf-body');},onClose:error=>reasons.push(chatFailure(error))});
 const first=await open();streams[0].emit('data',frame('invalid-protobuf'));streams[0].emit('close');assert.equal(first.closed,true);assert.deepEqual(reasons,[{reason:'protocol',stage:'decode'}]);
 const second=await open();second.close(douyinChatError('heartbeat-timeout','receive'));assert.deepEqual(reasons.at(-1),{reason:'heartbeat-timeout',stage:'receive'});assert.equal(reasons.length,2);
});
