import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliMetadata } from '../../server/downloader/platforms/bilibili.mjs';
import { PlatformResolver } from '../../server/downloader/platforms/resolver.mjs';

const bvid='BV1QHeM6fEw8';
const page=(page=1)=>({page,cid:41962963711+page,part:`分段 ${page}`,duration:209,dimension:{width:3170,height:1440},first_frame:'https://i0.hdslb.com/bfs/frame.jpg'});
const blocked=()=>Object.assign(new Error('HTTP 412'),{upstreamStatus:412});
test('normal metadata keeps title, author, cover and pages without extra requests',async()=>{
  const data={bvid,title:'投稿标题',owner:{name:'作者'},pic:'https://i0.hdslb.com/bfs/cover.jpg',pages:[page()]};let calls=0;
  assert.deepEqual(await bilibiliMetadata(bvid,{requestJson:async()=>{calls++;return {code:0,data};}}),data);
  assert.equal(calls,1);
});
test('HTTP 412 falls back to the exact public BV pagelist and retains all parts and default P',async()=>{
  const calls=[],resolver=new PlatformResolver({requestJson:async(url,options)=>{
    calls.push(new URL(url).pathname);assert.equal(new URL(url).searchParams.get('bvid'),bvid);
    assert.equal(Object.keys(options.headers).some(k=>/cookie|authorization/i.test(k)),false);
    if(url.includes('/view?'))throw blocked();return {code:0,data:[page(1),page(2)]};
  }});
  const result=await resolver.resolve(`https://www.bilibili.com/video/${bvid}/?p=2`);
  assert.equal(result.id,bvid);assert.equal(result.current,2);assert.equal(result.author,'哔哩哔哩');
  assert.equal(result.title,`B 站投稿 ${bvid}`);assert.equal(result.assets.length,2);assert.equal(result.assets[1].cid,41962963713);
  assert.deepEqual(calls,['/x/web-interface/wbi/view','/x/web-interface/view','/x/player/pagelist']);
});
test('single-video fallback preserves the actual part title and does not fabricate an author',async()=>{
  const data=await bilibiliMetadata(bvid,{requestJson:async url=>url.includes('/pagelist?')?{code:0,data:[{...page(),part:'依旧清一下每日体力'}]}:{code:-352}});
  assert.equal(data.title,'依旧清一下每日体力');assert.equal(data.owner,null);assert.equal(data.pages[0].duration,209);
});
test('a recoverable API code uses legacy metadata before falling back to pagelist',async()=>{
  let calls=0;const data={bvid,title:'完整标题',pages:[page()]};
  assert.deepEqual(await bilibiliMetadata(bvid,{requestJson:async()=>++calls===1?{code:-412}:{code:0,data}}),data);assert.equal(calls,2);
});
for(const code of [-404,-403,-101,62002,62004])test(`restricted or missing code ${code} never requests another metadata endpoint`,async()=>{
  let calls=0;await assert.rejects(bilibiliMetadata(bvid,{requestJson:async()=>{calls++;return {code};}}),/不可公开访问/);assert.equal(calls,1);
});
test('HTTP 403 is not treated as recoverable metadata failure',async()=>{
  let calls=0;await assert.rejects(bilibiliMetadata(bvid,{requestJson:async()=>{calls++;throw Object.assign(new Error('HTTP 403'),{upstreamStatus:403});}}),/不可公开访问/);assert.equal(calls,1);
});
test('metadata for a different BV is rejected',async()=>{
  let calls=0;await assert.rejects(bilibiliMetadata(bvid,{requestJson:async()=>{calls++;return {code:0,data:{bvid:'BV1dELb62EBy',pages:[page()]}};}}),/不完整/);assert.equal(calls,1);
});
test('failed or malformed fallback cannot create a partial or empty video list',async()=>{
  for(const data of [[],null,[page(2)],[{...page(),cid:0}],[{...page(),cid:1.5}],[{...page(),duration:-1}]]){
    await assert.rejects(bilibiliMetadata(bvid,{requestJson:async url=>{if(url.includes('/pagelist?'))return {code:0,data};throw blocked();}}),/分 P 信息不完整/);
  }
  await assert.rejects(bilibiliMetadata(bvid,{requestJson:async()=>{throw blocked();}}),/暂时限制/);
});
test('cancellation stops fallback requests',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(bilibiliMetadata(bvid,{signal:controller.signal,requestJson:async()=>{calls++;controller.abort();throw blocked();}}),{name:'AbortError'});assert.equal(calls,1);
});
test('the recovered CID still uses actual highest anonymous quality with intermediate tiers',async()=>{
  const resolver=new PlatformResolver({requestJson:async url=>{
    if(url.includes('/view?'))throw blocked();
    if(url.includes('/pagelist?'))return {code:0,data:[page()]};
    const params=new URL(url).searchParams;assert.equal(params.get('cid'),'41962963712');assert.equal(params.get('try_look'),'1');
    return {code:0,data:{quality:80,dash:{video:[{id:32,width:852,height:388,baseUrl:'https://a.bilivideo.com/480.m4s'},{id:64,width:1280,height:582,baseUrl:'https://a.bilivideo.com/720.m4s'}],audio:[{baseUrl:'https://a.bilivideo.com/audio.m4s'}]},support_formats:[{quality:64,new_description:'720P 高清'}]}};
  }});
  const result=await resolver.bilibili(bvid,1);const streams=await resolver.bilibiliStreams(result,result.assets[0]);
  assert.equal(streams.width,1280);assert.equal(streams.height,582);assert.equal(streams.quality,'720P 高清');
});
