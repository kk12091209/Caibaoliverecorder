import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

test('cached avatar endpoint is offline, source scoped and unavailable after material deletion',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-avatar-api-'));
  const app=await createApp({noRecorder:true,preparation:false,compact:false,data:path.join(root,'data'),port:0,ffmpeg:'not-executed',ffprobe:'not-executed'});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const session=app.store.createSession({status:'finished'}),other=app.store.createSession({status:'finished'});
  const source=app.store.addSource(session.id,path.join(root,'sample.flv'),0,undefined,true),hash='a'.repeat(64),png=Buffer.from([137,80,78,71,13,10,26,10]);
  app.store.run('INSERT INTO linkmic_avatars VALUES(?,?,?)',source.id,hash,png);
  const url=id=>`http://127.0.0.1:${app.port}/api/sessions/${id}/linkmic-avatars/${source.id}/${hash}.png`;
  const response=await fetch(url(session.id));
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal((await fetch(url(other.id))).status,404);
  app.store.run("UPDATE sessions SET deleted_at='2026-10-20' WHERE id=?",session.id);
  assert.equal((await fetch(url(session.id))).status,404);
});
