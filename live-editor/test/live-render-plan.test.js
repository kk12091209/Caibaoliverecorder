import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RenderPipeline, renderBlocks, hashRender } from '../server/render-plan.js';
import { liveRenderBlocks, blockLinkmicEvents, liveMetadataReady, liveLayoutWithinBudget } from '../server/render-live-state.js';
import { transportFixture, flvTag } from './helpers/source-stream-fixture.js';
import { normalizedDanmakuStyle } from '../shared/danmaku-style.js';
import { ChatRuleIndex } from '../server/chat-rules.js';
import { RenderCache } from '../server/render-cache.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

const hardware={id:'h264_videotoolbox',hardware:true,args:['-allow_sw','0','-q:v','65']};
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-live-render-'));
  const f=await transportFixture(root,{seconds:250,start:0,videoBytes:40,live:true});
  const {store,source}=f;await fs.writeFile(source.xml,'<i>');
  f.events=[];store.chatRules=new ChatRuleIndex(store);
  const index=async()=>{const s=store.get('SELECT pos FROM sources WHERE id=?',source.id);store.setting('linkmic-index:'+source.id,{mode:'original',pos:s.pos});};
  store.linkmic={tick:index,ensure:index,events:()=>f.events};await index();
  f.cache=new Map();f.renders=0;f.held=0;
  const lease=(key,spec)=>({key,spec,bytes:100,release(){f.held--;}});
  const cache={revision:0,async acquire(spec){const key=hashRender(spec);if(!f.cache.has(key))return null;f.held++;return lease(key,spec);},async build(spec,render,options){await render('unused');const verified=await options.verifySource();if(verified!==true)throw Object.assign(new Error('not verified'),{code:verified?.pending?'PREP_PENDING':'PREP_STALE'});const key=hashRender(spec);f.cache.set(key,spec);cache.revision++;f.held++;return lease(key,spec);}};
  f.media={store,renderCache:cache,fonts:{selected:()=>null},idlePolicy:{threads:2,choose:async()=>({concurrency:2})},
    probeSource:async(_source,_from,options)=>{if(options?.live)assert.equal(options.fresh,true);return {width:320,height:180,fps:30,codec:'h264'};},
    assertFullReady(session,sources){if(session.status!=='finished'||sources.some(s=>s.closed!==2))throw new Error('wait for recording');}};
  f.renderer=new RenderPipeline(f.media,()=>'',{blockSeconds:60});f.renderer.encoder=async()=>hardware;
  f.renderer.renderVideo=async(...args)=>{f.renders++;await f.onRender?.(...args);};
  f.comment=(id,time,text='hello')=>store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',id,f.session.id,source.id,time,'viewer',text,'d','16777215');
  t.after(async()=>{await f.media.renderCache.close?.();assert.equal(f.held,0);store.chatRules.close();f.ingest.stop();store.close();await fs.rm(root,{recursive:true,force:true});});
  return f;
}
async function plan(f,live=true){return f.renderer.describe(f.session.id,f.store.edit(f.session.id),null,live?{live:{tailSeconds:90}}:{});}
async function finish(f){f.store.run('UPDATE sources SET closed=1 WHERE id=?',f.source.id);await f.ingest.tick();f.store.run("UPDATE sessions SET status='finished' WHERE id=?",f.session.id);}

async function pendingFixture(t) {
  const f=await fixture(t);
  f.media.renderCache=new RenderCache(f.store.root,{minFreeBytes:0});
  f.renderer.renderVideo=async(_plan,_source,_from,_to,file)=>{f.renders++;await fs.writeFile(file,minimalMp4);await f.onRender?.();};
  f.onRender=()=>{f.onRender=null;f.store.setting('linkmic-index:'+f.source.id,{mode:'original',pos:0});};
  const result=await f.renderer.prepareNext(f.session.id,{live:true});
  assert.equal(result.waiting,'metadata');assert.equal(f.renders,1);assert.equal(f.media.renderCache.pending.size,1);
  assert.equal(await f.media.renderCache.hasReady(f.session.id),false);
  return f;
}

test('a completed block survives temporary metadata lag and is published without another render',async t=>{
  const f=await pendingFixture(t);await f.store.linkmic.ensure();
  const result=await f.renderer.prepareNext(f.session.id,{live:true});
  assert.equal(result.preparedSeconds,60);assert.equal(f.renders,1);assert.equal(f.media.renderCache.pending.size,0);
  assert.equal(await f.media.renderCache.hasReady(f.session.id),true);
});

test('late comments and style edits while metadata is pending discard the old pixels',async t=>{
  for(const change of ['comment','style']){
    const f=await pendingFixture(t);await f.store.linkmic.ensure();
    if(change==='comment')f.comment('pending-late',20);else f.store.setting('danmaku-style',normalizedDanmakuStyle({size:1.5,opacity:100}));
    const result=await f.renderer.prepareNext(f.session.id,{live:true});
    assert.equal(result.preparedSeconds,60);assert.equal(f.renders,2);assert.equal(f.media.renderCache.pending.size,0);
  }
});

test('recording completion can verify the same pending block without rerendering it',async t=>{
  const f=await pendingFixture(t);await finish(f);f.media.idlePolicy={threads:2,choose:async()=>({concurrency:1,reason:'last-block'})};
  const result=await f.renderer.prepareNext(f.session.id);
  assert.equal(result.preparedSeconds,60);assert.equal(f.renders,1);assert.equal(f.media.renderCache.pending.size,0);
});

test('live selection only accepts full sealed blocks behind the tail and distinguishes index/codec waits',()=>{
  const source={id:'a',start:0,duration:219},blocks=renderBlocks([source]);
  assert.deepEqual(liveRenderBlocks([source],blocks,{rangeStatus:()=>({ready:true,codecStable:true})}).blocks.map(b=>b.startMs),[0,60000]);
  assert.equal(liveRenderBlocks([source],blocks,{rangeStatus:()=>({ready:false,codecStable:true})}).waiting,'metadata');
  assert.equal(liveRenderBlocks([source],blocks,{rangeStatus:()=>({ready:false,codecStable:false})}).waiting,'codec');
  assert.equal(liveRenderBlocks([source],blocks,{tailSeconds:300,rangeStatus:()=>assert.fail()}).blocks.length,0);
});

test('live runs one full block, remains unfinished at the tail, and closed export reuses the same specifications',async t=>{
  const f=await fixture(t);const a=await f.renderer.prepareNext(f.session.id,{live:{tailSeconds:90}});
  assert.equal(f.renders,1);assert.equal(a.live,true);assert.equal(a.done,false);assert.equal(a.preparedSeconds,60);
  const b=await f.renderer.prepareNext(f.session.id,{live:{tailSeconds:90}});
  assert.equal(f.renders,2);assert.equal(b.preparedSeconds,120);assert.equal(b.waiting,'tail');assert.equal(b.nextEligibleAt,270);assert.ok(b.retryAfterMs>=20000&&b.retryAfterMs<=22000);
  const c=await f.renderer.prepareNext(f.session.id,{live:{tailSeconds:90}});assert.equal(f.renders,2);assert.equal(c.preparedSeconds,120);
  await assert.rejects(plan(f,false),/wait for recording/);
  const previous=[...f.cache.keys()];await finish(f);const final=await plan(f,false);
  for(let i=0;i<2;i++)assert.equal(hashRender(await f.renderer.spec(final,final.blocks[i])),previous[i]);
});

test('future link-mic end extension preserves old blocks while nickname and avatar changes invalidate them',async t=>{
  const f=await fixture(t),source=f.source.id;
  f.events=[{source,time:1,end:130,participants:[{name:'before',id:'1',avatar:'a'.repeat(64),audioOnly:true}]}];
  const first=await plan(f),before=await f.renderer.spec(first,first.blocks[0]);
  f.events[0]={...f.events[0],end:200};const extended=await plan(f);
  assert.deepEqual(await f.renderer.spec(extended,extended.blocks[0]),before);
  f.events[0]={...f.events[0],participants:[{...f.events[0].participants[0],name:'after'}]};const renamed=await plan(f);
  assert.notEqual((await f.renderer.spec(renamed,renamed.blocks[0])).assHash,before.assHash);
  f.events[0].participants[0].avatar='b'.repeat(64);const avatar=await plan(f);
  assert.notEqual((await f.renderer.spec(avatar,avatar.blocks[0])).assHash,(await f.renderer.spec(renamed,renamed.blocks[0])).assHash);
  assert.deepEqual(blockLinkmicEvents([{source,time:-2,end:200,participants:[{name:'x'}]}],source,0,60).map(e=>[e.time,e.end]),[[0,60]]);
});

test('late comments at a block boundary invalidate every affected canonical block',async t=>{
  const f=await fixture(t),before=await plan(f),keys=await Promise.all(before.blocks.map(b=>f.renderer.spec(before,b)));
  f.comment('late',58.5);const after=await plan(f),changed=await Promise.all(after.blocks.map(b=>f.renderer.spec(after,b)));
  assert.notEqual(changed[0].assHash,keys[0].assHash);assert.notEqual(changed[1].assHash,keys[1].assHash);
  f.comment('future',200);const future=await plan(f);
  assert.deepEqual(await Promise.all(future.blocks.map(b=>f.renderer.spec(future,b))),changed);
});

test('repeat-policy reason changes with unchanged filter row counts cannot reuse an old layout',async t=>{
  const f=await fixture(t);f.comment('old',30);
  f.store.run("INSERT INTO danmaku_filters VALUES(?,'lottery')",'old');const before=await plan(f);
  assert.equal(before.layout.length,1);
  f.store.run("UPDATE danmaku_filters SET reason='repeat' WHERE message=?",'old');const after=await plan(f);
  assert.equal(after.layout.length,0);
});

test('late comment or style changes during encoding reject publication instead of caching stale pixels',async t=>{
  for(const change of ['comment','style']){
    const f=await fixture(t);f.onRender=()=>{if(change==='comment')f.comment('during',20);else f.store.setting('danmaku-style',normalizedDanmakuStyle({size:1.5,opacity:100}));};
    const result=await f.renderer.prepareNext(f.session.id,{live:{tailSeconds:90}});
    assert.equal(result.waiting,'metadata');assert.equal(result.done,false);assert.equal(f.cache.size,0);assert.equal(f.held,0);
  }
});

test('editing existing text during final signature verification cannot publish stale pixels',async t=>{
  const f=await fixture(t);f.comment('edited',20);let mutate=false;
  f.onRender=()=>{mutate=true;};const spec=f.renderer.spec.bind(f.renderer);
  f.renderer.spec=async(...args)=>{const result=await spec(...args);if(mutate){mutate=false;f.store.run("UPDATE danmaku SET text='验证期间改动' WHERE id='edited'");}return result;};
  const result=await f.renderer.prepareNext(f.session.id,{live:true});
  assert.equal(result.waiting,'metadata');assert.equal(f.cache.size,0);
});

test('filtering only future comments during final verification preserves the completed old block',async t=>{
  const f=await fixture(t);f.comment('future-flag',200);let mutate=false;
  f.onRender=()=>{mutate=true;};const spec=f.renderer.spec.bind(f.renderer);
  f.renderer.spec=async(...args)=>{const result=await spec(...args);if(mutate){mutate=false;f.store.run("INSERT INTO danmaku_filters VALUES('future-flag','repeat')");}return result;};
  const result=await f.renderer.prepareNext(f.session.id,{live:true});
  assert.equal(result.preparedSeconds,60);assert.equal(f.cache.size,1);assert.equal(f.renders,1);
});

test('no hardware, unfinished XML, lagging linkmic and multiple codec epochs wait without rendering',async t=>{
  const f=await fixture(t);f.renderer.encoder=async()=>({id:'libx264',hardware:false});
  assert.equal((await f.renderer.prepareNext(f.session.id,{live:true})).waiting,'codec');assert.equal(f.renders,0);
  f.renderer.encoder=async()=>hardware;await f.store.linkmic.ensure();
  await fs.appendFile(f.source.xml,'<d p="20,1,25,16777215">pending</d>');
  assert.equal(await liveMetadataReady(f.store,f.store.sources(f.session.id)),false);
  await f.ingest.readDanmaku(f.store.sources(f.session.id)[0]);assert.equal(await liveMetadataReady(f.store,f.store.sources(f.session.id)),true);
  f.store.setting('linkmic-index:'+f.source.id,{mode:'original',pos:0});assert.equal(await liveMetadataReady(f.store,f.store.sources(f.session.id)),false);
  const next=flvTag(9,250000,24,{header:true});next[16]^=1;
  await fs.appendFile(f.file,Buffer.concat([next,flvTag(9,250000,40,{key:true}),flvTag(9,251000,40,{key:true})]));await f.ingest.tick();
  assert.equal((await f.renderer.prepareNext(f.session.id,{live:true})).waiting,'codec');assert.equal(f.renders,0);
});


test('new future media and comments do not discard an in-flight old block or rescan all ready block specifications',async t=>{
  const f=await fixture(t),spec=f.renderer.spec.bind(f.renderer);let specs=0;
  f.renderer.spec=async(...args)=>{specs++;return spec(...args);};
  f.onRender=async()=>{
    f.onRender=null;f.comment('future',200);
    await fs.appendFile(f.file,Buffer.concat([flvTag(9,250000,40,{key:true}),flvTag(9,251000,40,{key:true})]));await f.ingest.tick();
  };
  const first=await f.renderer.prepareNext(f.session.id,{live:true});assert.equal(first.preparedSeconds,60);assert.equal(f.cache.size,1);
  await f.renderer.prepareNext(f.session.id,{live:true});assert.equal(f.renders,2);
  const before=specs;f.comment('later',220);
  const waiting=await f.renderer.prepareNext(f.session.id,{live:true});assert.equal(waiting.waiting,'tail');assert.equal(specs,before);assert.equal(f.renders,2);
});

test('live cancellation releases operation tracking without publishing a partial result',async t=>{
  const f=await fixture(t),controller=new AbortController();f.onRender=()=>controller.abort();
  await assert.rejects(f.renderer.prepareNext(f.session.id,{live:true,signal:controller.signal}),{code:'PREP_CANCELLED'});
  assert.equal(f.cache.size,0);assert.equal(f.renderer.operations.size,0);assert.equal(f.held,0);
});

test('large layouts defer before probing or sorting while preserving every row and the complete post-record path',async t=>{
  for(const kind of ['comments','linkmic']) {
    const f=await fixture(t),limit=kind==='comments'?50000:10000;
    const add=i=>kind==='comments'?f.comment('large-'+i,i/50,'message '+i):
      f.store.run('INSERT INTO linkmic_frames(source,time,end,data) VALUES(?,?,?,?)',f.source.id,i,i+1,'{}');
    f.store.transaction(()=>{for(let i=0;i<limit;i++)add(i);});
    assert.equal(liveLayoutWithinBudget(f.store,f.session.id),true);
    add(limit);assert.equal(liveLayoutWithinBudget(f.store,f.session.id),false);
    const probe=f.media.probeSource;let layoutCalls=0;
    f.media.probeSource=()=>assert.fail('a deferred live layout must not start media probing');
    f.renderer.layout=async()=>{layoutCalls++;return [];};
    const result=await f.renderer.prepareNext(f.session.id,{live:true});
    assert.equal(result.waiting,'layout-budget');assert.equal(result.retryAfterMs,30000);
    assert.equal(layoutCalls,0);assert.equal(f.renders,0);
    const count=kind==='comments'?f.store.get('SELECT COUNT(*) AS count FROM danmaku WHERE session=?',f.session.id).count:
      f.store.get('SELECT COUNT(*) AS count FROM linkmic_frames WHERE source=?',f.source.id).count;
    assert.equal(count,limit+1,'no comments or link-mic data are discarded by the live limit');
    f.media.probeSource=probe;await finish(f);await plan(f,false);
    assert.equal(layoutCalls,1,'finished material still takes the unrestricted canonical layout path');
  }
});
