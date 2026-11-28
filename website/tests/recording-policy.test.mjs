import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createPolicyServer} from '../server/recording-policy.mjs';
import {POLICY_FILES,readRecordingPolicy} from '../../live-editor/shared/recording-policy.js';

test('测试名单通过网页发布和解除，正式名单保留为空，过期表单与异站写入被拒绝', async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'policy-site-test-'));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const origin='https://caibao.media';
  const emulator=async url=>Response.json({code:0,data:url.includes('room_init')
    ?{uid:900,room_id:42}:{info:{uid:900,uname:'隔离测试主播'}}});
  const server=await createPolicyServer({directory,channel:'beta',origin,publicKey,
    privateKey:privateKey.export({format:'pem',type:'pkcs8'}),request:emulator});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port+'/admin/recorder-policy';
  const post=(params,source=origin)=>fetch(url,{method:'POST',headers:{origin:source},body:new URLSearchParams(params)});
  const read=async channel=>readRecordingPolicy(JSON.parse(await fs.readFile(path.join(directory,POLICY_FILES[channel]))),channel,publicKey);
  assert.match(await (await fetch(url)).text(),/当前没有禁录主播/);
  const link='https://live.bilibili.com/42',platform='bilibili',uid='900';
  const preview=await post({action:'review-add',platform,identity:link});
  assert.match(await preview.text(),/隔离测试主播/);
  const add={action:'add',platform,uid,link,revision:'1'};
  assert.equal((await post(add,'https://example.org')).status,403);
  assert.deepEqual((await read('beta')).entries,[]);
  assert.match(await (await post(add)).text(),/已发布禁录规则/);
  assert.deepEqual((await read('beta')).entries,[{platform,uid}]);
  assert.deepEqual((await read('stable')).entries,[]);
  assert.equal((await post(add)).status,400);
  assert.match(await (await post({action:'review-remove',platform,uid,revision:'2'})).text(),/确认解除禁录/);
  assert.match(await (await post({action:'remove',platform,uid,revision:'2'})).text(),/已发布解除规则/);
  assert.equal((await read('beta')).revision,3);
  assert.deepEqual((await read('beta')).entries,[]);
});
