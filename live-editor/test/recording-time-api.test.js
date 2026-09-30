import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createApp} from '../server/index.js';

test('素材详情保留重连前后的真实时间锚点，历史无锚点时仍提供场次开始时间',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-recording-time-api-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  let app;
  try {
    app=await createApp({automaticClean:false,preparation:false,data:root,port,noRecorder:true,ffmpeg:process.execPath,ffprobe:process.execPath});
    const created='2026-09-28T13:30:00.000Z';
    const session=app.store.createSession({title:'重连时间定位',created,status:'finished'});
    // The second wall clock intentionally differs from created + start, so
    // replacing the stored anchor with elapsed-time arithmetic would fail.
    const spans=[{start:0,duration:600,wall:created},{start:930.5,duration:70.25,wall:'2026-09-28T21:45:37.250+08:00'}];
    const ids=spans.map((span,index)=>{
      const source=app.store.addSource(session.id,path.join(root,`source-${index}.flv`),span.start,span.wall,true);
      app.store.run('UPDATE sources SET closed=2,duration=? WHERE id=?',span.duration,source.id);
      // Cached metadata avoids spawning any media tool for this API test.
      app.store.setting('metadata:'+source.id,{width:320,height:180,fps:30,codec:'h264'});
      return source.id;
    });
    app.store.run('UPDATE sessions SET duration=? WHERE id=?',1000.75,session.id);
    const url=`http://127.0.0.1:${port}/api/sessions/${session.id}`;
    const response=await fetch(url);assert.equal(response.status,200);
    const detail=await response.json();
    assert.equal(detail.created,created);assert.equal(detail.duration,1000.75);
    assert.deepEqual(detail.sources.map(({id,start,duration,wall})=>({id,start,duration,wall})),spans.map((span,index)=>({id:ids[index],...span})));

    // Older imported/indexed sources can have no wall-clock field. Preserve
    // that absence and the original session anchor for the UI's fallback.
    app.store.run('UPDATE sources SET wall=NULL WHERE id=?',ids[1]);
    const legacyResponse=await fetch(url);assert.equal(legacyResponse.status,200);
    const legacy=await legacyResponse.json();
    assert.equal(legacy.sources[1].wall,null);assert.equal(legacy.created,created);
    assert.ok(Number.isFinite(Date.parse(legacy.created)));
    assert.deepEqual(legacy.sources.map(({start,duration})=>({start,duration})),spans.map(({start,duration})=>({start,duration})));
    assert.equal(app.recorder.process,null);assert.equal(app.media.children.size,0);
  } finally {
    if(app)await app.close();
    if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-recording-time-api-'))await fs.rm(root,{recursive:true,force:true});
  }
});
