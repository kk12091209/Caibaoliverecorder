import test from 'node:test';import assert from 'node:assert/strict';
import {BilibiliRoomResolver} from '../server/room-lookup.js';import {DouyinResolver} from '../server/douyin-room.js';import {Recorder} from '../server/recorder.js';import {DouyinRecorder} from '../server/douyin-recorder.js';
import {biliFixture,biliReplacement,douyinFixture} from './credential-fixtures.js';
test('platform queries attach only their own credential to fixed official hosts with redirects forbidden',async()=>{
 const calls=[],credentials={get:p=>p==='bilibili'?biliFixture:douyinFixture};
 const bili=new BilibiliRoomResolver({credentials,request:async(url,options)=>{calls.push({url,options});return new Response('{"code":0,"data":{"uid":123}}');}});
 const douyin=new DouyinResolver({credentials,request:async(url,options)=>{calls.push({url,options});return new Response('{"status_code":0,"data":{"id_str":"456"}}');}});
 assert.equal(await bili.verifyCookie(),true);assert.equal(await douyin.verifyCookie(),true);
 assert.equal(calls.length,2);for(const [index,{url,options}]of calls.entries()){assert.equal(new URL(url).hostname,index?'live.douyin.com':'api.live.bilibili.com');assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,index?douyinFixture:biliFixture);assert.ok(!url.includes('synthetic'));}
});
test('Bilibili runtime delivery is serialized, retries failure and never falls back to ordinary config',async()=>{
 const settings=new Map(),store={root:'/private/tmp/never-written-auth',setting(k,v){if(v!==undefined)settings.set(k,v);return settings.get(k);}};let value=biliFixture,now=1000;
 const recorder=new Recorder(store,{credentials:{get:()=>value},lifecycle:{now:()=>now}}),calls=[];let unsupported=true;
 recorder.api=async(route,input)=>{calls.push({route,input});if(unsupported)throw Object.assign(new Error('missing endpoint'),{coreStatus:404});return {supported:true,configured:!!input.cookie};};
 await recorder.applyCredentials();assert.match(recorder.credentialStatus.error,/新核心/);assert.equal(recorder.credentialRetry,true);assert.deepEqual([...new Set(calls.map(c=>c.route))],['credentials/cookie']);
 unsupported=false;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,true);value=biliReplacement;await Promise.all([recorder.applyCredentials(),recorder.applyCredentials()]);assert.equal(calls.at(-1).input.cookie,biliReplacement);
 value='';unsupported=true;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,true);assert.match(recorder.credentialStatus.error,/清除/);unsupported=false;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,false);assert.equal(recorder.credentialRetry,false);recorder.close();
});
test('an in-flight Douyin room lookup cannot overwrite a replacement cookie or restart video',async()=>{
 const settings=new Map([['douyin-rooms',[{webRid:'1',autoRecord:true,enabled:true}]]]),store={setting(k,v){if(v!==undefined)settings.set(k,v);return settings.get(k);},all:()=>[]};
 let resolveMetadata;const updates=[],resolver={cookie:async()=>({cookie:douyinFixture,userUniqueId:'2'}),room:async()=>new Promise(r=>resolveMetadata=r)};
 const recorder=new DouyinRecorder(store,{resolver,chat:{setRateLimit(){},update(...args){updates.push(args);},close:async()=>{}}});recorder.started=true;const room=recorder.entries.get('1');room.sourceId='source';room.metadata={cookie:'previous'};
 const poll=recorder.poll(true);await new Promise(r=>setImmediate(r));await recorder.credentialsChanged();resolveMetadata({webRid:'1',streaming:true,cookie:'previous',userUniqueId:'1'});await poll;
 assert.equal(room.metadata.cookie,douyinFixture);assert.equal(updates.length,1);assert.equal(updates[0][2].reauthenticate,true);assert.equal(room.nextPoll,0);recorder.started=false;recorder.closed=true;
});
test('adding a room retries stale metadata when Cookie changes during the lookup',async()=>{
 const settings=new Map(),store={setting(k,v){if(v!==undefined)settings.set(k,v);return settings.get(k);}};let firstResolve,count=0;
 const resolver={cookie:async()=>({cookie:douyinFixture,userUniqueId:'2'}),room:async webRid=>{count++;if(count===1)return new Promise(r=>firstResolve=r);return {webRid,name:'主播',roomId:'99',streaming:false,cookie:douyinFixture,userUniqueId:'2'};}};
 const recorder=new DouyinRecorder(store,{resolver,chat:{setRateLimit(){},close:async()=>{}}});const add=recorder.add({webRid:'1'},false);await new Promise(r=>setImmediate(r));await recorder.credentialsChanged();firstResolve({webRid:'1',name:'主播',roomId:'99',streaming:false,cookie:'old',userUniqueId:'1'});await add;
 assert.equal(count,2);assert.equal(recorder.entries.get('1').metadata.cookie,douyinFixture);await recorder.close();
});
