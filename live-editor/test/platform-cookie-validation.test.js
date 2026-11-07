import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp,fetch} from './helpers/authenticated-app.js';
import {BilibiliRoomResolver} from '../server/room-lookup.js';
import {DouyinResolver} from '../server/douyin-room.js';
import {testProtection,biliFixture,biliReplacement,douyinFixture} from './credential-fixtures.js';

const biliExpired={code:-101,data:{isLogin:false}};
const douyinExpired={status_code:20003,data:{message:"User doesn't login"}};
const biliValid={code:0,data:{isLogin:true,mid:12345}};
const douyinValid={status_code:0,data:{id_str:'12345'}};

test('each account probe only treats an explicit login rejection as expiry',async()=>{
  for(const [Resolver,cookie,host,valid,expired] of [
    [BilibiliRoomResolver,biliFixture,'api.bilibili.com',biliValid,biliExpired],
    [DouyinResolver,douyinFixture,'live.douyin.com',douyinValid,douyinExpired],
  ]){
    let response;
    const resolver=new Resolver({request:async(url,options)=>{
      assert.equal(new URL(url).hostname,host);
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Cookie,cookie);
      return response();
    }});
    response=()=>Response.json(valid);
    assert.equal(await resolver.verifyCookie({cookie}),true);
    response=()=>Response.json(expired);
    assert.equal(await resolver.verifyCookie({cookie}),false);
    for(const reply of [
      ()=>Response.json(expired,{status:403}),()=>Response.json(expired,{status:429}),
      ()=>Response.json({code:-412,status_code:20003,data:{message:'rate limited'}}),
      ()=>Response.json(null),()=>new Response('<html>challenge</html>'),
      ()=>{throw new DOMException('timeout','TimeoutError');},
    ]){
      response=reply;
      await assert.rejects(resolver.verifyCookie({cookie}));
    }
  }
});

test('automatic account checks apply anonymous Bilibili credentials during recording and persist separate reminders across restart',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cookie-expiry-')),protection=testProtection();
  const open=()=>createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,
    ffmpeg:'not-executed',ffprobe:'not-executed',credentialOptions:{protection}});
  let app=await open();
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const request=async(route,input,headers={})=>{
    const result=await fetch(`http://127.0.0.1:${app.port}/api/${route}`,input===undefined?undefined:{
      method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input),
    });
    const body=await result.text();
    assert.ok(!body.includes('synthetic'));
    return {status:result.status,body:JSON.parse(body)};
  };
  const credential=(platform,action,input={})=>request(`platform-credentials/${platform}/${action}`,input);
  await credential('bilibili','save',{cookie:biliFixture});
  await credential('douyin','save',{cookie:douyinFixture});
  const bili=app.recorder.bilibili,douyin=app.recorder.douyin;
  const delivered=[];
  bili.online=true;
  bili.rooms=[{roomId:1016,recording:true}];
  bili.api=async(route,input)=>{
    assert.equal(route,'credentials/cookie','expiry must only use the hot update endpoint');
    delivered.push(input.cookie);
    return {supported:true,configured:!!input.cookie};
  };
  let now=1000,biliChecks=0,douyinChecks=0,douyinResult=douyinValid;
  app.cookieValidation.now=()=>now;
  bili.resolver.request=async()=>{biliChecks++;return Response.json(biliExpired);};
  douyin.resolver.request=async()=>{douyinChecks++;return Response.json(douyinResult);};
  await Promise.all([app.cookieValidation.tick(),app.cookieValidation.tick()]);
  const [first]=app.snapshot().credentialWarnings;
  assert.equal(first.platform,'bilibili');
  assert.deepEqual(delivered,['']);
  assert.equal(bili.rooms[0].recording,true);
  assert.equal(app.credentials.get('douyin'),douyinFixture);
  assert.equal((await request('platform-credentials')).body.platforms.bilibili.expired,true);
  assert.equal((await credential('bilibili','unlock')).body.platforms.bilibili.expired,true);
  assert.equal(app.credentials.get('bilibili'),'');
  assert.equal((await request('platform-credentials/bilibili/acknowledge',{generation:first.generation},{Origin:'https://example.invalid'})).status,403);
  assert.equal((await credential('bilibili','acknowledge',{generation:first.generation})).status,200);
  await app.cookieValidation.tick();
  assert.deepEqual([biliChecks,douyinChecks],[1,1]);
  assert.deepEqual(app.snapshot().credentialWarnings,[]);
  now+=120001;
  douyinResult=douyinExpired;
  await app.cookieValidation.tick();
  assert.deepEqual(app.snapshot().credentialWarnings.map(item=>item.platform),['douyin']);

  await app.close();
  app=await open();
  assert.deepEqual(app.snapshot().credentialWarnings.map(item=>item.platform),['douyin']);
  assert.equal(app.credentials.get('bilibili'),'','restart must not reapply the expired login');
  assert.equal((await request('platform-credentials')).body.platforms.bilibili.configured,true);
  assert.equal((await credential('bilibili','save',{cookie:biliFixture})).body.platforms.bilibili.expired,false);
  app.recorder.bilibili.resolver.request=async()=>Response.json(biliExpired);
  await app.cookieValidation.tick();
  const renewed=app.snapshot().credentialWarnings.find(item=>item.platform==='bilibili');
  assert.notEqual(renewed.generation,first.generation,'saving again starts a new generation even for the same value');
  await credential('bilibili','acknowledge',{generation:first.generation});
  assert.equal(app.snapshot().credentialWarnings[0].generation,renewed.generation);
  await credential('bilibili','delete');
  assert.equal(app.credentials.get('bilibili'),'');
  assert.deepEqual(app.snapshot().credentialWarnings.map(item=>item.platform),['douyin']);
});

test('a delayed rejection cannot disable a replacement and unknown responses keep the effective login',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cookie-race-'));
  const app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,
    ffmpeg:'not-executed',ffprobe:'not-executed',credentialOptions:{protection:testProtection()}});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  await app.credentials.save('bilibili',biliFixture);
  let respond;
  app.recorder.bilibili.resolver.request=()=>new Promise(resolve=>{respond=resolve;});
  const checking=app.cookieValidation.tick();
  assert.ok(respond);
  await app.credentials.save('bilibili',biliReplacement);
  respond(Response.json(biliExpired));
  await checking;
  assert.equal(app.credentials.get('bilibili'),biliReplacement);
  assert.deepEqual(app.snapshot().credentialWarnings,[]);
  app.recorder.bilibili.resolver.request=async()=>Response.json(biliExpired,{status:429});
  await app.cookieValidation.tick();
  assert.equal(app.cookieValidation.status('bilibili'),'unavailable');
  assert.equal(app.credentials.get('bilibili'),biliReplacement);
  assert.deepEqual(app.snapshot().credentialWarnings,[]);
});
