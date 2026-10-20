import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.js';
import { avatarUrl,safeAvatarUrl,downloadAvatar,LinkmicAvatars } from '../server/linkmic-avatars.js';
import { labelGeometry } from '../shared/linkmic-labels.js';

test('avatar downloads accept only platform images, bound bytes and do not forward visitor cookies',async()=>{
  const url='https://p3.douyinpic.com/avatar.jpeg';
  assert.equal(avatarUrl({avatar_thumb:{url_list:['http://127.0.0.1/a',url]}}),url);
  for(const value of ['http://p3.douyinpic.com/a','https://p3.douyinpic.com.evil.test/a','https://127.0.0.1/a','https://x@p3.douyinpic.com/a','https://p3.douyinpic.com:8000/a'])
    assert.equal(safeAvatarUrl(value),'');
  const jpeg=Buffer.from([255,216,255,1]);
  assert.deepEqual(await downloadAvatar(url,{request:async(_url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.headers.Cookie,undefined);
    return new Response(jpeg);
  }}),jpeg);
  await assert.rejects(downloadAvatar(url,{request:async()=>new Response('<svg/>')}),/格式/);
  await assert.rejects(downloadAvatar(url,{request:async()=>new Response(Buffer.alloc(1024*1024+1))}),/过大/);
});
test('avatars are cached by content, survive restart, stay scoped to the source and are removed with it',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-avatar-cache-'));let store=new Store(root);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession(),source=store.addSource(session.id,path.join(root,'sample.flv'));
  store.run('INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?)',source.id,'room','voice','102','语音用户');
  let requests=0;const png=Buffer.from('normalized');
  const options={request:async()=>{requests++;return new Response(Buffer.from([255,216,255,1]));},normalize:async()=>png};
  const person={linkId:'voice',id:'102',avatarUrl:'https://p3.douyinpic.com/a.jpeg'};
  await new LinkmicAvatars(store,options).capture(source,'room',person);
  store.close();store=new Store(root);
  await new LinkmicAvatars(store,options).capture(source,'room',person);
  assert.equal(requests,1,'cached images need no network after restart');
  const image=store.get('SELECT avatar FROM linkmic_people WHERE source=?',source.id).avatar;
  assert.deepEqual(Buffer.from(store.get('SELECT png FROM linkmic_avatars WHERE source=? AND hash=?',source.id,image).png),png);
  assert.equal(store.get('SELECT png FROM linkmic_avatars WHERE source=? AND hash=?','other-source',image),undefined);
  store.run('DELETE FROM sources WHERE id=?',source.id);
  assert.equal(store.get('SELECT COUNT(*) n FROM linkmic_avatars').n,0);
});
test('audio tiles fit their own rectangle and video or host tiles do not receive avatars',()=>{
  const voice={x:.761,y:.678,w:.205,h:.119,audioOnly:true,avatarUrl:'/local.png',name:'语音用户'};
  for(const [w,h] of [[1280,720],[390,220],[1088,1920]]) {
    const g=labelGeometry(voice,w,h,1088,1920);
    assert.equal(g.audioOnly,true);assert.equal(g.avatar,'/local.png');
    assert.ok(g.avatarX>=g.left&&g.avatarX+g.avatarSize<=g.right);
    assert.ok(g.avatarY>=g.top&&g.avatarY+g.avatarSize<g.y-g.size);
  }
  assert.equal(labelGeometry({...voice,audioOnly:false},1088,1920).audioOnly,false);
  assert.equal(labelGeometry({...voice,owner:true},1088,1920).audioOnly,false);
});
