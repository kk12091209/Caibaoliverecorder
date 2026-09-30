import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
for(const kind of ['probe','enqueue'])test('关闭服务等待在途'+kind+'退出后再关数据库',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-storage-shutdown-'));
 const app=await createApp({automaticClean:false,preparation:false,data:root,noRecorder:true,compact:false,port:0,ffmpeg:'unused-test-tool',ffprobe:'unused-test-tool'});
 let release;const pending=new Promise(resolve=>release=resolve);
 const method=kind==='probe'?'probeSourceInternal':'enqueueInternal';
 app.media[method]=async()=>{await pending;app.store.setting('shutdown-proof',kind);return kind;};
 const operation=kind==='probe'?app.media.probeSource({id:'fixture',session:'fixture'}):app.media.enqueue('fixture',{});
 let closed=false;const shutdown=app.close().then(()=>{closed=true;});
 try{
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(closed,false);
  release();assert.equal(await operation,kind);await shutdown;assert.equal(closed,true);
 }finally{release();await shutdown;await fs.rm(root,{recursive:true,force:true});}
});
