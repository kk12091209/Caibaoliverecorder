import test from 'node:test';import assert from 'node:assert/strict';
import {BilibiliRoomResolver} from '../server/room-lookup.js';import {DouyinResolver} from '../server/douyin-room.js';import {Recorder} from '../server/recorder.js';
import {biliFixture,biliReplacement,douyinFixture} from './credential-fixtures.js';
test('platform account credentials stay isolated and clearing Douyin restores anonymous bootstrap',async()=>{
 let douyinCookie=douyinFixture;
 const calls=[],credentialReads=[],credentials={get:p=>{credentialReads.push(p);return p==='bilibili'?biliFixture:douyinCookie;}};
 const bili=new BilibiliRoomResolver({credentials,request:async(url,options)=>{calls.push({url,options});return Response.json({code:0,data:{isLogin:true,mid:123}});}});
 assert.equal(await bili.verifyCookie(),true);
 assert.equal(calls[0].url,'https://api.bilibili.com/x/web-interface/nav');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Cookie,biliFixture);
 credentialReads.length=0;
 const douyin=new DouyinResolver({credentials,request:async(url,options)=>{calls.push({url,options});return new Response('',{headers:{'Set-Cookie':'ttwid=anonymous-visitor; Path=/'}});}});
 const signedIn=await douyin.cookie();assert.equal(signedIn.cookie,douyinFixture);assert.equal(calls.length,1);
 assert.ok(credentialReads.length>0);assert.deepEqual([...new Set(credentialReads)],['douyin']);
 douyinCookie='';
 const visitor=await douyin.cookie();assert.equal(visitor.cookie,'ttwid=anonymous-visitor');
 assert.equal(calls[1].url,'https://live.douyin.com/');assert.equal(calls[1].options.redirect,'error');assert.equal(calls[1].options.headers.Cookie,undefined);
 assert.equal(await douyin.cookie(),visitor);assert.equal(calls.length,2);
 assert.equal(await bili.verifyCookie(),true);assert.equal(calls[2].options.headers.Cookie,biliFixture);
});
test('Bilibili runtime delivery is serialized, retries failure and never falls back to ordinary config',async()=>{
 const settings=new Map(),store={root:'/private/tmp/never-written-auth',setting(k,v){if(v!==undefined)settings.set(k,v);return settings.get(k);}};let value=biliFixture,now=1000;
 const recorder=new Recorder(store,{credentials:{get:()=>value},lifecycle:{now:()=>now}}),calls=[];let unsupported=true;
 recorder.api=async(route,input)=>{calls.push({route,input});if(unsupported)throw Object.assign(new Error('missing endpoint'),{coreStatus:404});return {supported:true,configured:!!input.cookie};};
 await recorder.applyCredentials();assert.match(recorder.credentialStatus.error,/新核心/);assert.equal(recorder.credentialRetry,true);assert.deepEqual([...new Set(calls.map(c=>c.route))],['credentials/cookie']);
 unsupported=false;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,true);value=biliReplacement;await Promise.all([recorder.applyCredentials(),recorder.applyCredentials()]);assert.equal(calls.at(-1).input.cookie,biliReplacement);
 value='';unsupported=true;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,true);assert.match(recorder.credentialStatus.error,/清除/);unsupported=false;await recorder.applyCredentials();assert.equal(recorder.credentialStatus.applied,false);assert.equal(recorder.credentialRetry,false);recorder.close();
});
