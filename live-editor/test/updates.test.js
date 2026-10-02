import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { Updates, newerRelease, validateUpdate, githubFetch, UPDATE_REPOSITORY, packageName } from '../server/updates.js';
import { createApp } from '../server/index.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const current={version:'0.1.6',revision:2};
function publication(platform='win32-x64',revision=3){
  const bytes=Buffer.from('verified update package\n'),version='0.1.6',tag_name='v'+version,name=packageName(version,platform);
  const manifest={schema:1,version,revision,notes:['修复测试问题'],platforms:{[platform]:{name,size:bytes.length,sha256:sha(bytes)}}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  const asset=(name,bytes)=>({name,size:bytes.length,state:'uploaded',digest:'sha256:'+sha(bytes),browser_download_url:`https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag_name}/${name}`});
  const release={tag_name,draft:false,prerelease:false,assets:[asset('update-manifest.json',manifestBytes),asset(name,bytes)]};
  return {bytes,manifest,manifestBytes,release,name};
}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-updates-')),store=new Store(root),published=publication(options.platform),calls=[];
  const fetcher=async(url,init)=>{calls.push(url);if(url.includes('api.github.com'))return Response.json(published.release);if(url.endsWith('update-manifest.json'))return new Response(published.manifestBytes);return new Response(published.bytes);};
  const updates=new Updates(store,{current,platform:'win32-x64',fetcher,...options});
  t.after(async()=>{await updates.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,updates,published,calls,fetcher};
}
async function downloaded(f){await f.updates.check();f.updates.download(f.updates.candidate.key);await f.updates.downloadTask;}

test('相同版本依靠修订号更新，较老版本和修订不会降级',()=>{
  assert.equal(newerRelease({...current,revision:3},current),true);
  assert.equal(newerRelease(current,current),false);
  assert.equal(newerRelease({version:'0.1.5',revision:999},current),false);
  assert.equal(newerRelease({version:'0.1.7',revision:1},current),true);
  for(const version of ['v0.1.6','0.1.6-beta','../../x','1.2'])assert.throws(()=>newerRelease({version,revision:3},current));
  assert.throws(()=>newerRelease({...current,revision:0},current));
});
test('Windows 与 Mac 只选择各自的安装包',()=>{
  for(const platform of ['win32-x64','darwin-arm64']){
    const p=publication(platform);assert.equal(validateUpdate(p.release,p.manifest,current,platform).name,p.name);
    assert.throws(()=>validateUpdate(p.release,p.manifest,current,'linux-x64'));
  }
});
test('拒绝草稿、预发布、错误版本以及附件清单不一致',()=>{
  for(const mutate of [p=>p.release.draft=true,p=>p.release.prerelease=true,p=>p.release.tag_name='v0.1.7',p=>p.release.assets[1].digest='sha256:'+'0'.repeat(64),p=>p.manifest.platforms['win32-x64'].size++,p=>p.release.assets.push(p.release.assets[1]),p=>p.manifest.notes=['x'.repeat(501)]]){
    const p=publication();mutate(p);assert.throws(()=>validateUpdate(p.release,p.manifest,current,'win32-x64'));
  }
});
test('仅联系固定 GitHub 仓库及发布 CDN，拒绝跳转到本机和其他站点',async()=>{
  for(const target of ['http://127.0.0.1:1234/test','https://evil.example/test','file:///tmp/test','https://user@release-assets.githubusercontent.com/x']){
    let calls=0;
    await assert.rejects(githubFetch(`https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.1.6/test`,{fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:target}});}}),/不受信任/);
    assert.equal(calls,1);
  }
  let calls=0;
  const response=await githubFetch(`https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.1.6/test`,{fetcher:async()=>++calls===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file?signature=test'}}):new Response('ok')});
  assert.equal(await response.text(),'ok');assert.equal(calls,2);
});
test('检查合并并发请求并限制频率；稍后提醒针对具体修订持久保存',async t=>{
  let now=200000;const f=await fixture(t,{now:()=>now});
  await Promise.all([f.updates.check(),f.updates.check()]);assert.equal(f.calls.length,2);
  assert.equal(f.updates.snapshot().candidate.revision,3);
  assert.equal(f.updates.defer().deferred,true);
  await f.updates.check();assert.equal(f.calls.length,2);
  now+=86400001;assert.equal(f.updates.snapshot().deferred,false);
  await f.updates.check();assert.equal(f.calls.length,4);
});
test('关闭自动检查仍允许手动检查；网络超时不会永久保持检查中',async t=>{
  const f=await fixture(t,{checkTimeoutMs:20});f.updates.setEnabled(false);f.updates.autoCheck();assert.equal(f.calls.length,0);
  await f.updates.check();assert.equal(f.updates.status,'available');
  f.updates.lastAttempt=0;
  f.updates.fetcher=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const keepAlive=setTimeout(()=>{},1000);try{await f.updates.check();}finally{clearTimeout(keepAlive);}
  assert.equal(f.updates.status,'available');assert.match(f.updates.error,/检查更新失败/);assert.equal(f.updates.checkTask,null);
});
test('清单校验失败时不提供下载，也不访问被篡改的地址',async t=>{
  const f=await fixture(t);f.published.manifestBytes=Buffer.from('tampered');await f.updates.check();
  assert.equal(f.updates.status,'error');assert.equal(f.updates.candidate,null);assert.throws(()=>f.updates.download('0.1.6-r3'));
  f.updates.lastAttempt=0;f.published.release.assets[0].browser_download_url='http://localhost/private';
  await f.updates.check();assert.ok(f.calls.every(url=>url.startsWith('https://')));
});
test('下载通过大小和 SHA 校验后才可打开，重复点击不会重复下载',async t=>{
  const f=await fixture(t);await f.updates.check();f.updates.download(f.updates.candidate.key);f.updates.download(f.updates.candidate.key);await f.updates.downloadTask;
  assert.equal(f.calls.length,3);assert.equal(f.updates.status,'ready');
  const file=await f.updates.installPath();assert.deepEqual(await fs.readFile(file),f.published.bytes);
  assert.deepEqual(await fs.readdir(f.updates.root),[f.published.name]);
});
test('录制或导出期间拒绝安装；本地安装包被改动后也拒绝安装',async t=>{
  let active=false;const f=await fixture(t,{activity:()=>({requiresExitConfirmation:active})});await downloaded(f);
  active=true;assert.match(f.updates.snapshot().installBlocked,/停止录制/);await assert.rejects(f.updates.installPath(),/停止录制/);
  active=false;await fs.writeFile(f.updates.ready.file,Buffer.alloc(f.published.bytes.length));await assert.rejects(f.updates.installPath(),/校验失败/);
});
test('错误或超大的下载不替换已存在文件，并清理自己的临时文件',async t=>{
  for(const extra of [0,1]){
    const f=await fixture(t);await fs.mkdir(f.updates.root);const file=path.join(f.updates.root,f.published.name);await fs.writeFile(file,'keep previous');
    f.updates.fetcher=async(url,init)=>url.endsWith('.exe')?new Response(Buffer.alloc(f.published.bytes.length+extra)):f.fetcher(url,init);
    await downloaded(f);assert.equal(f.updates.status,'available');assert.match(f.updates.error,/校验失败|大小不符/);
    assert.equal(await fs.readFile(file,'utf8'),'keep previous');assert.deepEqual(await fs.readdir(f.updates.root),[f.published.name]);
  }
});
test('取消和退出能够结束下载并清理临时文件',async t=>{
  for(const close of [false,true]){
    const f=await fixture(t);let started;const ready=new Promise(resolve=>started=resolve);
    f.updates.fetcher=async(url,init)=>url.endsWith('.exe')?new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});controller.enqueue(new Uint8Array([1]));started();}})):f.fetcher(url,init);
    await f.updates.check();f.updates.download(f.updates.candidate.key);await ready;
    if(close)await f.updates.close();else {f.updates.cancel();await f.updates.downloadTask;}
    assert.equal(f.updates.downloadTask,null);assert.equal(f.updates.ready,null);assert.deepEqual(await fs.readdir(f.updates.root),[]);
  }
});
test('拒绝更新缓存符号链接，保留链接外的文件',async t=>{
  const f=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-update-outside-'));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'keep'),'safe');
  try{await fs.symlink(outside,f.updates.root,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('symlink not permitted');return;}throw error;}
  await downloaded(f);assert.equal(f.updates.status,'available');assert.match(f.updates.error,/目录不安全/);assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'safe');
});
test('重启后可复用已校验安装包；清理更新缓存保留其他数据',async t=>{
  const f=await fixture(t);await downloaded(f);await f.updates.close();
  const next=new Updates(f.store,{current,platform:'win32-x64',fetcher:f.fetcher});t.after(()=>next.close());
  await next.check();assert.equal(next.status,'ready');await fs.writeFile(path.join(f.root,'user-video.flv'),'keep');
  await next.clearCache();assert.equal(next.snapshot().hasCache,false);assert.equal(await fs.readFile(path.join(f.root,'user-video.flv'),'utf8'),'keep');
});
test('已安装相同修订不提醒，历史下载缓存仍可手动清理',async t=>{
  const f=await fixture(t,{current:{...current,revision:3}});await f.updates.check();assert.equal(f.updates.status,'current');assert.equal(f.updates.candidate,null);
});
test('安装路径仅通过授权桌面通道提供；Web 更新接口不接受路径或任意 URL',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-update-api-'));const p=publication();
  const app=await createApp({data:root,port:0,noRecorder:true,preparation:false,compact:false,updateOptions:{platform:'win32-x64',fetcher:async url=>url.includes('api.github.com')?Response.json(p.release):new Response(url.endsWith('update-manifest.json')?p.manifestBytes:p.bytes)}});
  app.ingestor.stop();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const post=(route,body={},headers={})=>fetch(app.runtime.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/internal/desktop',{action:'prepareUpdate'})).status,403);
  await post('/api/updates/check');const state=await(await fetch(app.runtime.origin+'/api/state')).json();
  assert.equal(state.updates.current.version,'0.1.6');assert.equal(state.updates.current.revision,2);
  assert.equal((await post('/api/updates/download',{key:'wrong',url:'http://localhost/test'})).status,400);
  assert.equal((await post('/api/updates/download',{key:state.updates.candidate.key})).status,202);await app.updates.downloadTask;
  const response=await post('/internal/desktop',{action:'prepareUpdate'},{'X-Caibo-Instance':app.runtime.token});assert.equal(response.status,200);
  const result=await response.json();assert.equal(path.dirname(result.updatePath),path.join(root,'updates'));
});

test('下载无进展会结束并清理临时文件；启动恢复只清理已登记的临时文件',async t=>{
  const f=await fixture(t,{idleMs:20});
  f.updates.fetcher=async(url,init)=>url.endsWith('.exe')?new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}})):f.fetcher(url,init);
  const keepAlive=setTimeout(()=>{},1000);try{await downloaded(f);}finally{clearTimeout(keepAlive);}
  assert.match(f.updates.error,/超时/);assert.deepEqual(await fs.readdir(f.updates.root),[]);
  const owned='12345678-1234-1234-1234-123456789012.part';
  await fs.writeFile(path.join(f.updates.root,owned),'partial');await fs.writeFile(path.join(f.updates.root,'unrelated.part'),'keep');
  f.store.setting('update-partial',owned);await f.updates.recover();
  assert.deepEqual(await fs.readdir(f.updates.root),['unrelated.part']);assert.equal(f.store.setting('update-partial'),null);
});

test('发布清单要求两端版本、修订、源码和真实验证结果一致',async()=>{
  const {createUpdateManifest}=await import('../scripts/create-update-manifest.mjs');
  const sourceRevision='a'.repeat(40),w={version:'0.1.6',buildRevision:2,sourceRevision};
  for(const key of ['nodeTests','coreTests','coreLifecycle','portableZip','portable7z','installerUpgradeUninstall'])w[key]='passed';
  const m={version:w.version,buildRevision:2,applicationSourceRevision:sourceRevision,releaseRevision:sourceRevision,nodeTests:{passed:1,failed:0},localChecks:{dmgManifest:'passed',zipManifest:'passed'}};
  const a=publication(),b=publication('darwin-arm64');
  const r={...a.release,target_commitish:sourceRevision,assets:[a.release.assets[1],b.release.assets[1]]};
  const manifest=createUpdateManifest(r,w,m,['测试修订']);assert.equal(manifest.revision,2);assert.equal(Object.keys(manifest.platforms).length,2);
  for(const mutate of [x=>x[1].buildRevision++,x=>x[2].applicationSourceRevision='b'.repeat(40),x=>x[1].portable7z='failed',x=>delete x[2].nodeTests.passed,x=>x[0].assets[0].digest=null,x=>x[0].assets.push(x[0].assets[0])]){
    const values=structuredClone([r,w,m,['测试修订']]);mutate(values);assert.throws(()=>createUpdateManifest(...values));
  }
});
