import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createApp} from '../server/index.js';

test('设置仅保存导出目录；移除登录、恢复、旧下载接口，保留失败清理及重试',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-settings-cleanup-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const app=await createApp({data:path.join(root,'data'),projectRoot:root,port,noRecorder:true,automaticClean:false,preparation:false,compact:false,ffmpeg:process.execPath,ffprobe:process.execPath});
  app.ingestor.stop();app.deletionMaintenance.next=Infinity;
  t.after(async()=>{await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('bili-settings-cleanup-'));await fs.rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${port}`,post=(route,body)=>fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  app.recorder.api=async()=>{assert.fail('Settings must not forward a login request to the recorder');};
  const destination=path.join(root,'exports');assert.equal((await post('/api/settings',{exportDirectory:destination})).status,200);
  assert.equal((await post('/api/settings',{cookie:'dummy',exportDirectory:path.join(root,'must-not-create')})).status,400);
  assert.equal(app.store.setting('export-directory'),destination);await assert.rejects(fs.stat(path.join(root,'must-not-create')),{code:'ENOENT'});
  const state=await(await fetch(origin+'/api/state')).json();assert.deepEqual(state.pendingCleanup,[]);assert.equal(Object.hasOwn(state,'trash'),false);
  const s=app.store.createSession({status:'finished',title:'待清理素材'}),file=path.join(root,'data','originals','recording.flv');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'footage');
  const source=app.store.addSource(s.id,file,0,s.created,true);app.store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
  const unlink=fs.unlink.bind(fs),mock=t.mock.method(fs,'unlink',async target=>{if(target===file)throw Object.assign(new Error('file locked'),{code:'EBUSY'});return unlink(target);});
  try{assert.equal((await post(`/api/sessions/${s.id}/delete`,{confirmed:true})).status,400);}finally{mock.mock.restore();}
  const failed=await(await fetch(origin+'/api/state')).json();assert.equal(failed.sessions.length,0);assert.equal(failed.pendingCleanup.length,1);assert.equal(failed.pendingCleanup[0].status,'finished');assert.match(failed.pendingCleanup[0].purge_error,/EBUSY/);
  for(const action of ['restore','archive'])assert.equal((await post(`/api/sessions/${s.id}/${action}`,{})).status,404);
  for(const route of [`/api/sessions/${s.id}/archive/video`,`/api/jobs/none/video`,`/api/jobs/none/xml`])assert.equal((await fetch(origin+route)).status,404);
  assert.equal((await post(`/api/sessions/${s.id}/delete`,{confirmed:true})).status,200);
  assert.deepEqual((await(await fetch(origin+'/api/state')).json()).pendingCleanup,[]);await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
