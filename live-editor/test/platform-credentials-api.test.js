import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createApp} from '../server/index.js';
import {testProtection,biliFixture,biliReplacement,douyinFixture} from './credential-fixtures.js';
test('local credential API never returns secrets, replaces Bilibili, removes Douyin support, survives restart and rejects cross-origin writes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cookie-api-')),protection=testProtection();
 const open=()=>createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch',credentialOptions:{protection}});
 let app=await open();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
 const request=async(route,input,headers={})=>{const r=await fetch(`http://127.0.0.1:${app.port}/api/${route}`,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:input===undefined?undefined:JSON.stringify(input)});const text=await r.text();assert.ok(!text.includes('synthetic'));return {status:r.status,body:JSON.parse(text)};};
 assert.equal((await request('platform-credentials')).body.platforms.bilibili.configured,false);
 assert.equal((await request('platform-credentials/bilibili/save',{cookie:biliFixture},{Origin:'https://example.invalid'})).status,403);
 const saved=await request('platform-credentials/bilibili/save',{cookie:biliFixture});assert.equal(saved.status,200);assert.equal(saved.body.platforms.bilibili.configured,true);assert.equal(saved.body.platforms.bilibili.loaded,true);
 for(const action of ['save','delete','verify'])assert.equal((await request(`platform-credentials/douyin/${action}`,action==='save'?{cookie:douyinFixture}:{})).status,404);
 assert.deepEqual(Object.keys(saved.body.platforms),['bilibili']);
 const original=await fs.readFile(app.credentials.file('bilibili'));
 const unlocked=await request('platform-credentials/bilibili/unlock',{});assert.equal(unlocked.status,200);assert.equal(unlocked.body.platforms.bilibili.loaded,true);
 assert.deepEqual(await fs.readFile(app.credentials.file('bilibili')),original);
 assert.equal((await request('platform-credentials/bilibili/unlock',{cookie:biliReplacement})).status,400);
 protection.fail=true;assert.equal((await request('platform-credentials/bilibili/save',{cookie:biliReplacement})).status,400);assert.equal(app.credentials.get('bilibili'),biliFixture);protection.fail=false;
 assert.equal((await request('platform-credentials/bilibili/save',{cookie:biliReplacement})).status,200);assert.equal(app.credentials.get('bilibili'),biliReplacement);assert.equal(app.credentials.get('douyin'),'');
 assert.equal((await request('platform-credentials/bilibili/save',{cookie:biliFixture,unexpected:true})).status,400);
 const bad=await fetch(`http://127.0.0.1:${app.port}/api/platform-credentials/bilibili/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"cookie":"synthetic-broken-secret'});assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes('synthetic'));
 assert.ok(!JSON.stringify(app.snapshot()).includes('synthetic'));
 await app.close();for(const item of await fs.readdir(root,{recursive:true,withFileTypes:true})){if(item.isFile()){const bytes=await fs.readFile(path.join(item.parentPath,item.name));assert.ok(!bytes.includes(Buffer.from('synthetic')),item.name);}}
 app=await open();await app.startupRecovery;assert.equal(app.credentials.get('bilibili'),biliReplacement);assert.equal((await request('platform-credentials')).body.platforms.douyin,undefined);
 assert.equal((await request('platform-credentials/bilibili/delete',{})).body.platforms.bilibili.configured,false);assert.equal(app.credentials.get('bilibili'),'');assert.equal(app.credentials.get('douyin'),'');
});
