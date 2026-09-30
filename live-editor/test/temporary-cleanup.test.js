import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TemporaryWorkspaces, processRunning } from '../server/temp-workspaces.js';
import { Media } from '../server/media.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-temp-cleanup-test-'));
const MARKER='.bili-temp-owner.json',deadPid=400000001;
const missing=async file=>assert.rejects(fs.access(file),error=>error.code==='ENOENT');
async function workspace(name,prefix='bili-export-') {
  const temporaryRoot=path.join(root,name,'data','temp'),manager=new TemporaryWorkspaces(temporaryRoot);
  return {temporaryRoot,manager,directory:await manager.create(prefix)};
}
async function orphan(f,changes={}) {
  const file=path.join(f.directory,MARKER),data=JSON.parse(await fs.readFile(file,'utf8'));
  await fs.writeFile(file,JSON.stringify({...data,ownerPid:deadPid,...changes}));f.manager.active.clear();
}
const collector=temporaryRoot=>new TemporaryWorkspaces(temporaryRoot,{processAlive:pid=>pid===process.pid});

test('有效owner的已退出孤儿被清理，probe/export临时文件与owner标记一起移除',async()=>{
  const f=await workspace('orphan');await fs.writeFile(path.join(f.directory,'part-0.mp4'),'large work file');await fs.writeFile(path.join(f.directory,'part-0.ass'),'subtitle');await orphan(f);
  const probe=await f.manager.create('bili-probe-');await fs.writeFile(path.join(probe,'sample.flv'),'sample');await orphan({...f,directory:probe});
  const original=path.join(path.dirname(f.temporaryRoot),'originals');await fs.mkdir(original);await fs.writeFile(path.join(original,'keep.flv'),'original');
  const result=await collector(f.temporaryRoot).cleanupStale();assert.equal(result.removed,2);await missing(f.directory);await missing(probe);await fs.access(path.join(original,'keep.flv'));
});

test('当前服务、活着或复用的子PID，以及未完成spawn登记的目录都保留',async()=>{
  const live=await workspace('live');await fs.writeFile(path.join(live.directory,'final.mp4'),'active');
  assert.equal((await new TemporaryWorkspaces(live.temporaryRoot).cleanupStale()).removed,0);await fs.access(live.directory);
  const child=await live.manager.create('bili-probe-');await fs.writeFile(path.join(child,'sample.flv'),'child');await orphan({...live,directory:child},{childPids:[process.pid]});
  const pending=await live.manager.create('bili-export-');live.manager.beforeSpawn(pending);await orphan({...live,directory:pending});
  assert.equal((await collector(live.temporaryRoot).cleanupStale()).removed,0);
  for(const directory of [live.directory,child,pending])await fs.access(directory);
  assert.equal(processRunning(process.pid),true);
});

test('未知旧目录、无owner的full reservation、无效标记与陌生文件保持原样',async()=>{
  const f=await workspace('unknown');await fs.writeFile(path.join(f.directory,'用户原片.flv'),'keep');await orphan(f);
  const names=['bili-probe-old','bili-full-old','ordinary-user-folder','bili-export-invalid'];
  for(const name of names)await fs.mkdir(path.join(f.temporaryRoot,name));
  await fs.writeFile(path.join(f.temporaryRoot,'bili-export-invalid',MARKER),'{invalid json');
  const outside=path.join(f.temporaryRoot,'ordinary-user-folder','keep.xml');await fs.writeFile(outside,'chat');
  const result=await collector(f.temporaryRoot).cleanupStale();assert.equal(result.removed,0);
  for(const name of names)await fs.access(path.join(f.temporaryRoot,name));await fs.access(path.join(f.directory,'用户原片.flv'));await fs.access(outside);
});

test('按素材清理只处理自己的已退出工作区，活跃、待保存、邻居和未知文件不误删',async()=>{
  const f=await workspace('session-owned'),manager=f.manager;
  const own=await manager.create('bili-export-','my-session');await fs.writeFile(path.join(own,'part-0.mp4'),'own');
  const neighbor=await manager.create('bili-probe-','another-session');await fs.writeFile(path.join(neighbor,'sample.flv'),'neighbor');
  await assert.rejects(manager.removeSession('my-session'),/仍在处理/);await fs.access(own);
  await orphan({...f,directory:own});
  const result=await collector(f.temporaryRoot).removeSession('my-session');assert.equal(result.deletedFiles,2);await missing(own);await fs.access(neighbor);
  const retained=await manager.create('bili-export-','saved-session');await fs.writeFile(path.join(retained,'final.mp4'),'only encoded copy');
  await orphan({...f,directory:retained},{retained:{jobId:'pending-save'}});
  await assert.rejects(collector(f.temporaryRoot).removeSession('saved-session'),/等待保存/);await fs.access(path.join(retained,'final.mp4'));
  const unknown=await manager.create('bili-export-','unknown-session');await fs.writeFile(path.join(unknown,'keep.flv'),'user file');await orphan({...f,directory:unknown});
  await assert.rejects(collector(f.temporaryRoot).removeSession('unknown-session'),/无法确认/);await fs.access(path.join(unknown,'keep.flv'));
});

test('目录联接、内部链接和marker硬链接都不会穿透到其他文件',async()=>{
  const f=await workspace('links');await orphan(f);
  const outside=path.join(root,'outside-link-target');await fs.mkdir(outside);const kept=path.join(outside,'keep.flv');await fs.writeFile(kept,'outside original');
  await fs.symlink(outside,path.join(f.directory,'part-0.mp4'),process.platform==='win32'?'junction':'dir');
  const alias=path.join(f.temporaryRoot,'bili-export-linked');await fs.symlink(outside,alias,process.platform==='win32'?'junction':'dir');
  const hard=await f.manager.create('bili-probe-');await orphan({...f,directory:hard});await fs.link(kept,path.join(hard,'sample.flv'));
  const markerLink=await f.manager.create('bili-export-');await orphan({...f,directory:markerLink});await fs.link(path.join(markerLink,MARKER),path.join(outside,'owner-copy.json'));
  assert.equal((await collector(f.temporaryRoot).cleanupStale()).removed,0);
  for(const file of [kept,f.directory,alias,hard,markerLink])await fs.access(file);
});

test('temp根目录自身被junction重定向时不扫描目标',async()=>{
  const f=await workspace('root-link');await fs.writeFile(path.join(f.directory,'final.mp4'),'keep');await orphan(f);
  const alias=path.join(root,'temp-alias');await fs.symlink(f.temporaryRoot,alias,process.platform==='win32'?'junction':'dir');
  const result=await collector(alias).cleanupStale();assert.equal(result.removed,0);assert.ok(result.skipped);await fs.access(f.directory);
  await assert.rejects(new TemporaryWorkspaces(alias).create('bili-probe-'),/链接|路径/);
});

test('进程权限或状态检查异常按活跃处理，删除I/O失败保留marker以便重试',async t=>{
  const f=await workspace('errors');const work=path.join(f.directory,'final.mp4');await fs.writeFile(work,'keep until safe');await orphan(f);
  const uncertain=new TemporaryWorkspaces(f.temporaryRoot,{processAlive:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});}});
  assert.equal((await uncertain.cleanupStale()).removed,0);await fs.access(work);
  const unlink=fs.unlink.bind(fs),mocked=t.mock.method(fs,'unlink',async file=>{if(file===work)throw Object.assign(new Error('locked'),{code:'EPERM'});return unlink(file);});
  assert.equal((await collector(f.temporaryRoot).cleanupStale()).removed,0);await fs.access(work);await fs.access(path.join(f.directory,MARKER));mocked.mock.restore();
  assert.equal((await collector(f.temporaryRoot).cleanupStale()).removed,1);await missing(f.directory);
});

test('Media登记实际子进程PID，子进程运行期间finally保留目录，退出后自动完成清理',async()=>{
  const data=path.join(root,'actual-child','data'),media=new Media({root:data});
  const directory=await media.temporaryDirectory('bili-export-');await fs.writeFile(path.join(directory,'final.mp4'),'work');
  const child=media.spawnTracked(process.execPath,['-e','setTimeout(()=>{},10000)'],{windowsHide:true,stdio:'ignore'},directory);
  const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    const marker=JSON.parse(await fs.readFile(path.join(directory,MARKER),'utf8'));
    assert.equal(marker.ownerPid,process.pid);assert.equal(marker.pendingSpawns,0);assert.ok(marker.childPids.includes(child.pid));
    assert.equal(await media.temporaryWorkspaces.finish(directory),false);await fs.access(directory);
    assert.equal((await media.cleanupStaleTemporary()).removed,0);
  } finally {child.kill();await closed;await media.temporaryWorkspaces.finish(directory);media.close();}
  await missing(directory);
});

test('spawn前pending标记先落盘，登记后清除；普通完成清理支持重复并发调用',async()=>{
  const f=await workspace('pending-record');const ticket=f.manager.beforeSpawn(f.directory);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,MARKER),'utf8')).pendingSpawns,1);
  f.manager.spawned(ticket,null);assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,MARKER),'utf8')).pendingSpawns,0);
  await Promise.all([f.manager.finish(f.directory),f.manager.finish(f.directory),f.manager.cleanupStale()]);await missing(f.directory);
});

test('服务关闭先中止预览等待，再停止子进程',()=>{
  const media=new Media({root:path.join(root,'closing','data')}),controller=new AbortController();let killed=false;
  media.previews.set('preview',{controller});media.children.add({kill:()=>{assert.equal(controller.signal.aborted,true);killed=true;}});
  media.close();assert.equal(killed,true);assert.equal(media.closed,true);
  assert.throws(()=>media.spawnTracked(process.execPath,['-e','process.exit(0)'],{windowsHide:true}),/关闭/);
});

test('关闭期间尚未启动的probe不能再创建ffprobe进程，既有工作区仍可清理',async()=>{
  const media=new Media({root:path.join(root,'closing-probe','data')}),directory=await media.temporaryDirectory('bili-probe-');
  const file=path.join(directory,'sample.flv');await fs.writeFile(file,'sample');media.close();
  await assert.rejects(media.probe(file),/关闭/);assert.equal(media.children.size,0);
  await media.temporaryWorkspaces.finish(directory);await missing(directory);
});

test.after(async()=>{if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-temp-cleanup-test-'))await fs.rm(root,{recursive:true,force:true});});
