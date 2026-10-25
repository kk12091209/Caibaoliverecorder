import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { ExpiringCache } from '../../server/downloader/infrastructure/cache.mjs';
import { compatibleImage, MediaImages } from '../../server/downloader/media/images.mjs';
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs';
import { saveRemote } from '../../server/downloader/infrastructure/network.mjs';
import { PlatformResolver } from '../../server/downloader/platforms/resolver.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('image conversion produces real JPEG/PNG bytes at original dimensions and retains transparent pixels',async()=>{
  const opaque=await sharp({create:{width:120,height:80,channels:3,background:'#9e4455'}}).webp().toBuffer();
  const jpg=await compatibleImage(opaque);assert.equal(jpg.type,'image/jpeg');assert.equal(jpg.extension,'jpg');assert.deepEqual([...jpg.data.subarray(0,2)],[255,216]);
  assert.deepEqual([jpg.width,jpg.height],[120,80]);assert.equal((await sharp(jpg.data).metadata()).format,'jpeg');
  const pixels=Buffer.from([255,0,0,0,20,40,80,128,30,60,90,255]);
  const transparent=await sharp(pixels,{raw:{width:3,height:1,channels:4}}).webp({lossless:true}).toBuffer();
  const png=await compatibleImage(transparent);assert.equal(png.type,'image/png');assert.equal(png.extension,'png');assert.equal((await sharp(png.data).metadata()).hasAlpha,true);
  assert.deepEqual(await sharp(png.data).raw().toBuffer(),await sharp(transparent).raw().toBuffer());
  assert.deepEqual((await compatibleImage(jpg.data)).data,jpg.data);assert.deepEqual((await compatibleImage(png.data)).data,png.data);
});

test('image cache deduplicates fetches, creates a smaller fallback thumbnail and keeps the full-resolution preview',async()=>{
  const image=await sharp({create:{width:1440,height:1842,channels:3,background:'#ba7788'}}).webp().toBuffer();let reads=0;
  const images=new MediaImages({open:async()=>{reads++;await pause(10);return {status:200,headers:{'content-type':'image/webp','content-length':String(image.length)},stream:Readable.from([image])};}});
  try{
    const url='https://p11-sign.douyinpic.com/test.webp';
    const [a,b]=await Promise.all([images.preview(url,{size:'thumb'}),images.preview(url,{size:'thumb'})]);assert.equal(reads,1);assert.deepEqual(a,b);assert.equal((await sharp(a.data).metadata()).width,360);
    const full=await images.preview(url,{size:'full'});assert.equal(reads,1);assert.equal((await sharp(full.data).metadata()).width,1440);
    const download=await images.download([url]);assert.equal(reads,1);assert.equal(download.extension,'jpg');assert.equal(download.width,1440);
  }finally{await images.close();}
});

test('cancelled image preview does not cancel another visitor waiting on the same public image',async()=>{
  const input=await sharp({create:{width:20,height:20,channels:3,background:'red'}}).webp().toBuffer();let reads=0;
  const images=new MediaImages({open:async()=>{reads++;await pause(15);return {status:200,headers:{'content-type':'image/webp'},stream:Readable.from([input])};}}),controller=new AbortController();
  try{const first=images.original(['https://p11-sign.douyinpic.com/shared'],{signal:controller.signal});const second=images.original(['https://p11-sign.douyinpic.com/shared']);controller.abort();await assert.rejects(first);assert.deepEqual((await second).data,input);assert.equal(reads,1);}finally{await images.close();}
});

test('bounded cache evicts least recently used entries and expires metadata without caching errors',async()=>{
  let now=0;const cache=new ExpiringCache({maxEntries:3,maxBytes:6,ttl:10,now:()=>now});cache.set('a',1,3);cache.set('b',2,3);cache.get('a');cache.set('c',3,3);assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a'),1);now=11;assert.equal(cache.get('a'),undefined);
  const resolver=new PlatformResolver();let reads=0;resolver.resolveFresh=async()=>{reads++;return {id:'post'};};await resolver.resolve('https://v.douyin.com/abc/');await resolver.resolve('https://v.douyin.com/abc/');assert.equal(reads,1);
  resolver.resolveFresh=async()=>{reads++;if(reads===2)throw new Error('temporary');return {id:'retry'};};await assert.rejects(resolver.resolve('https://v.douyin.com/retry/'),/temporary/);await resolver.resolve('https://v.douyin.com/retry/');assert.equal(reads,3);
});

function rangeSource(data,mode='valid'){
  let calls=0,ranges=0;
  return {get calls(){return calls;},get ranges(){return ranges;},open:async(url,{headers}={})=>{
    calls++;const range=headers?.Range;
    const common={url,headers:{'content-type':'video/mp4','content-length':String(data.length),'accept-ranges':'bytes',etag:'"fixed-object"'}};
    if(!range||mode==='ignored')return {...common,status:200,stream:Readable.from([data])};
    ranges++;const [,a,b]=/bytes=(\d+)-(\d+)/.exec(range),start=Number(a),end=Number(b);
    return {...common,status:206,headers:{...common.headers,'content-range':`bytes ${start}-${end}/${data.length}`},stream:Readable.from([data.subarray(start,end+1-(mode==='short'?1:0))])};
  }};
}
for(const mode of ['valid','ignored','short'])test(`segmented download ${mode} keeps exact bytes and safely falls back when necessary`,async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-ranges-test-'));const data=Buffer.alloc(8*1024**2+21);for(let n=0;n<data.length;n++)data[n]=n%251;const source=rangeSource(data,mode);let previous=0;
  try{const result=await saveRemote(['https://a.bilivideo.com/test'],path.join(dir,'video.mp4'),{open:source.open,onProgress:bytes=>{if(mode==='valid')assert.ok(bytes>=previous);previous=bytes;}});assert.equal(result.parts,mode==='valid'?3:1);assert.equal(hash(await readFile(path.join(dir,'video.mp4'))),hash(data));assert.ok(source.calls>=4);}finally{await rm(dir,{recursive:true,force:true});}
});
test('segmented download respects quota errors instead of retrying and rejects oversized media before writing',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-range-limit-')),data=Buffer.alloc(8*1024**2+1),source=rangeSource(data);
  try{
    await assert.rejects(saveRemote(['https://a.bilivideo.com/test'],path.join(dir,'quota'),{open:source.open,onProgress:()=>{throw new Error('quota exceeded');}}),/quota exceeded/);assert.equal(source.calls,4);
    await assert.rejects(saveRemote(['https://a.bilivideo.com/test'],path.join(dir,'large'),{open:source.open,maxBytes:100}),/大小限制/);await assert.rejects(stat(path.join(dir,'large')));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('cancelling segmented downloads stops all ranges without falling back to a new download',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-range-cancel-')),controller=new AbortController(),data=Buffer.alloc(8*1024**2+1);let requests=0;
  const open=async(url,{headers}={})=>{
    requests++;if(requests===4)queueMicrotask(()=>controller.abort());const initial={url,status:200,headers:{'content-type':'video/mp4','content-length':String(data.length),'accept-ranges':'bytes'},stream:Readable.from([data])};if(!headers?.Range)return initial;
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(headers.Range);return {...initial,status:206,headers:{...initial.headers,'content-range':`bytes ${start}-${end}/${data.length}`},stream:Readable.from((async function*(){await pause(20);yield data.subarray(Number(start),Number(end)+1);})())};
  };
  try{await assert.rejects(saveRemote(['https://a.bilivideo.com/cancel'],path.join(dir,'cancel'),{open,signal:controller.signal}),{name:'AbortError'});assert.equal(requests,4);}finally{await rm(dir,{recursive:true,force:true});}
});

test('100-image jobs convert concurrently within four workers, retain order and ZIP actual JPG/PNG files',async()=>{
  const jpg=await compatibleImage(await sharp({create:{width:12,height:10,channels:3,background:'blue'}}).webp().toBuffer());
  const png=await compatibleImage(await sharp({create:{width:12,height:10,channels:4,background:{r:20,g:40,b:80,alpha:.3}}}).webp().toBuffer());let active=0,maximum=0;
  const images={download:async(urls,{signal,onProgress})=>{active++;maximum=Math.max(maximum,active);try{await pause(Number(urls[0])%3);signal.throwIfAborted();onProgress(100,100);return Number(urls[0])%2?jpg:png;}finally{active--;}}};
  const jobs=new DownloadJobs({}, {images});
  try{
    const session={owner:'owner',result:{kind:'images',title:'图片测试',url:'https://www.douyin.com/note/123',assets:Array.from({length:100},(_,n)=>({index:n+1,type:'image',urls:[String(n+1)]}))}};
    const created=jobs.create(session,session.result.assets.map(a=>a.index));const job=jobs.jobs.get(created.id);
    for(let n=0;n<500&&['queued','running'].includes(job.status);n++)await pause(10);
    assert.equal(job.status,'done',job.error);assert.equal(maximum,4);assert.deepEqual(job.files.map(f=>f.index),session.result.assets.map(a=>a.index));
    const entries=unzipSync(await readFile(job.archive.path));assert.equal(Object.keys(entries).length,100);
    for(const [name,bytes]of Object.entries(entries)){assert.match(name,/\.(jpg|png)$/);assert.equal((await sharp(bytes).metadata()).format,name.endsWith('.jpg')?'jpeg':'png');}
  }finally{await jobs.close();}
});
