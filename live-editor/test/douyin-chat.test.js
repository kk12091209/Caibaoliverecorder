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
