import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
const basic=token=>'Basic '+Buffer.from('caibao:'+token).toString('base64');
test('all data, SSE, HEAD/range and static UI are instance authenticated, without URL or cookie credentials',async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-access-'));const app=await createApp({data,port:0,noRecorder:true,ffmpeg:'not-used',ffprobe:'not-used',updatesAutoCheck:false});t.after(async()=>{await app.close();await fs.rm(data,{recursive:true,force:true});});await app.startupRecovery;
 for(const route of ['/api/state','/api/events','/api/jobs/missing/download','/api/sessions/missing/preview','/'])for(const method of ['GET','HEAD']){
  const denied=await fetch(app.runtime.origin+route,{method,headers:{Range:'bytes=0-1'}});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/Basic realm/);await denied.body?.cancel();
 }
 assert.equal((await fetch(app.runtime.origin+'/api/state?token='+app.runtime.uiToken,{headers:{Cookie:'token='+app.runtime.uiToken}})).status,401);
 assert.equal((await fetch(app.runtime.origin+'/api/state',{headers:{Authorization:basic('wrong')}})).status,401);
 const headers={Authorization:basic(app.runtime.uiToken)};const state=await fetch(app.runtime.origin+'/api/state',{headers});assert.equal(state.status,200);assert.doesNotMatch(await state.text(),new RegExp(app.runtime.uiToken+'|'+app.runtime.token));
 assert.equal((await fetch(app.runtime.origin+'/internal/desktop',{headers})).status,403);
 assert.equal((await fetch(app.runtime.origin+'/api/state',{headers:{...headers,Origin:'http://127.0.0.1:1'}})).status,403);
 const stream=await fetch(app.runtime.origin+'/api/events',{headers});assert.equal(stream.status,200);await stream.body.cancel();
 assert.equal((await fetch(app.runtime.origin+'/api/state',{headers:{'X-Caibo-Instance':app.runtime.token}})).status,200);
 const file=await fs.stat(app.runtime.file);if(process.platform!=='win32'){assert.equal(file.mode&0o077,0);assert.equal((await fs.stat(app.root)).mode&0o077,0);}
});
