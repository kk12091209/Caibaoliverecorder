import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DouyinChat} from '../server/douyin-chat.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function worker(){const instance=new EventEmitter();instance.sent=[];instance.postMessage=message=>{instance.sent.push(message);if(message.type==='stop')queueMicrotask(()=>instance.emit('message',{type:'stopped',key:message.key}));};instance.terminate=async()=>{instance.terminated=true;instance.emit('exit',0);};return instance;}
test('worker batches are acknowledged only after bounded disk writes, and stop drains writes before closing',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});let release,started=false;
 chat.start('source',{roomId:'7691637058724547364',cookie:'guest'}, {write:async()=>{started=true;await new Promise(resolve=>release=resolve);}});
 fake.emit('message',{type:'batch',key:'source',id:1,messages:[],density:[]});await turn();assert.equal(started,true);assert.equal(fake.sent.some(message=>message.type==='ack'),false);
 let stopped=false;const closing=chat.stop('source').then(()=>stopped=true);await turn();assert.equal(stopped,false);release();await closing;
 assert.equal(fake.sent.some(message=>message.type==='ack'&&message.id===1),true);assert.equal(fake.terminated,true);assert.equal(chat.clients.size,0);await chat.close();
});
test('a failed chat write releases worker quota and reports failure without stopping video callbacks',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake}),statuses=[];
 chat.start('source',{}, {write:async()=>{throw new Error('disk error');},status:value=>statuses.push(value)});
 fake.emit('message',{type:'batch',key:'source',id:2,messages:[],density:[]});await turn();assert.ok(statuses.includes('write-failed'));assert.ok(fake.sent.some(message=>message.type==='ack'));await chat.close();
});
test('dead worker stops promptly and does not reopen a room being finalized',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});chat.start('source',{}, {write:async()=>{}});
 const closing=chat.stop('source');fake.emit('error',new Error('worker unavailable'));await closing;await chat.close();assert.equal(chat.clients.size,0);assert.equal(chat.closed,true);
});
test('visitor refresh updates reconnect credentials without resetting sampling or healthy connections',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});chat.start('source',{cookie:'old',userUniqueId:'1'}, {write:async()=>{}});
 chat.update('source',{cookie:'new',userUniqueId:'2'});assert.equal(chat.clients.get('source').details.cookie,'new');assert.equal(fake.sent.filter(message=>message.type==='start').length,1);assert.equal(fake.sent.at(-1).type,'credentials');
 chat.update('source',{cookie:'new',userUniqueId:'2'});assert.equal(fake.sent.filter(message=>message.type==='credentials').length,1);await chat.close();
});

test('explicit login refresh reconnects even if a concurrent room poll has already copied the new credentials',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});
 try{
  chat.start('source',{cookie:'guest',userUniqueId:'1'},{write:async()=>{}});
  chat.update('source',{cookie:'sessionid=synthetic',userUniqueId:'2'});
  chat.update('source',{cookie:'sessionid=synthetic',userUniqueId:'2'},{reauthenticate:true});
  assert.equal(fake.sent.filter(message=>message.type==='credentials').length,2);
  assert.equal(fake.sent.at(-1).reauthenticate,true);
  assert.equal(fake.sent.filter(message=>message.type==='start').length,1,'keeps the existing sampling and persistence channel');
 }finally{await chat.close();}
});

test('worker reasons reach the recorder, first persisted batch follows disk completion, and protocol payloads never reach status consumers',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake}),events=[];let release;
 chat.start('source',{}, {write:()=>new Promise(resolve=>release=resolve),status:(state,detail)=>events.push([state,detail])});
 fake.emit('message',{type:'status',key:'source',status:'retry',stage:'upgrade',reason:'http',code:403,retryMs:6000,elapsedMs:120,message:'private-protocol',cookie:'private-cookie'});
 assert.deepEqual(events[0],['retry',{status:'retry',stage:'upgrade',reason:'http',code:403,elapsedMs:120,retryMs:6000}]);
 fake.emit('message',{type:'batch',key:'source',id:1,messages:[{text:'private-chat'}]});await turn();assert.equal(events.some(([state])=>state==='first-write'),false);
 release();await turn();assert.equal(events.filter(([state])=>state==='first-write').length,1);
 assert.doesNotMatch(JSON.stringify(events),/private/);fake.emit('error',new Error('private-worker-error'));assert.deepEqual(events.at(-1),['retry',{stage:'worker',reason:'worker-exit',retryMs:2000}]);
 await chat.close();
});

test('room snapshots follow disk completion, retain write failures across reconnects and clear them on recovered writes',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake}),statuses=[];let release;
 try{
  chat.start('source',{cookie:'private-cookie'}, {write:async message=>{if(message.id===1)await new Promise(resolve=>release=resolve);if(message.id===2)throw Error('private-disk-error');},status:value=>statuses.push(value)});
  assert.equal(chat.snapshot('source').connection,'connecting');assert.equal(chat.snapshot('missing'),null);
  fake.emit('message',{type:'status',key:'source',status:'connected'});
  fake.emit('message',{type:'status',key:'source',status:'first-comment'});
  fake.emit('message',{type:'batch',key:'source',id:1,messages:[{text:'private-comment'}]});await turn();
  assert.equal(chat.snapshot('source').received,true);assert.equal(chat.snapshot('source').written,false);assert.equal(fake.sent.some(m=>m.type==='ack'),false);
  release();await turn();assert.equal(chat.snapshot('source').written,true);assert.ok(fake.sent.some(m=>m.type==='ack'&&m.id===1));
  fake.emit('message',{type:'batch',key:'source',id:2,messages:[{text:'private-comment'}]});await turn();assert.equal(chat.snapshot('source').writeFailed,true);
  for(const status of ['retry','connecting','connected','first-frame'])fake.emit('message',{type:'status',key:'source',status});
  assert.equal(chat.snapshot('source').written,false);assert.equal(chat.snapshot('source').writeFailed,true);
  fake.emit('message',{type:'batch',key:'source',id:3,messages:[]});await turn();assert.equal(chat.snapshot('source').writeFailed,true);
  fake.emit('message',{type:'batch',key:'source',id:4,messages:[{text:'recovered'}]});await turn();assert.equal(chat.snapshot('source').written,true);assert.equal(chat.snapshot('source').writeFailed,false);
  assert.equal(statuses.filter(value=>value==='first-write').length,2,'recovered persistence clears the existing recorder warning once');
  assert.doesNotMatch(JSON.stringify(chat.snapshot('source')),/private/);
  fake.emit('error',Error('worker crashed'));assert.equal(chat.snapshot('source').connection,'retrying');assert.equal(chat.snapshot('source').written,false);
 }finally{release?.();await chat.close();}
});
test('an old pending write cannot mark a new connection as collecting, and stopping never reopens its state',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});let release;
 try{
  chat.start('source',{}, {write:async message=>{if(message.id===1)await new Promise(resolve=>release=resolve);}});
  fake.emit('message',{type:'status',key:'source',status:'connected'});
  fake.emit('message',{type:'batch',key:'source',id:1,messages:[{text:'old connection'}]});await turn();
  for(const status of ['retry','connecting','connected'])fake.emit('message',{type:'status',key:'source',status});
  release();await turn();assert.equal(chat.snapshot('source').written,false);
  fake.emit('message',{type:'batch',key:'source',id:2,messages:[{text:'new connection'}]});await turn();assert.equal(chat.snapshot('source').written,true);
  const stopping=chat.stop('source');assert.equal(chat.snapshot('source').connection,'stopped');
  fake.emit('message',{type:'status',key:'source',status:'connected'});assert.equal(chat.snapshot('source').connection,'stopped');await stopping;assert.equal(chat.snapshot('source'),null);
 }finally{release?.();await chat.close();}
});
test('snapshots are isolated per source and a startup failure does not invent a connection',async()=>{
 const fake=worker(),chat=new DouyinChat({createWorker:()=>fake});
 try{
  chat.start('a',{}, {write:async()=>{}});chat.start('b',{}, {write:async()=>{}});
  fake.emit('message',{type:'status',key:'a',status:'connected'});assert.equal(chat.snapshot('a').connected,true);assert.equal(chat.snapshot('b').connection,'connecting');
  const snapshot=chat.snapshot('a');snapshot.written=true;assert.equal(chat.snapshot('a').written,false);
 }finally{await chat.close();}
 const broken=new DouyinChat({createWorker:()=>{throw Error('startup failed');}});
 assert.throws(()=>broken.start('source',{}, {write:async()=>{}}),/startup failed/);assert.equal(broken.snapshot('source').connection,'unknown');await broken.close();
});
