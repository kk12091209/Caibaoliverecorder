import test from 'node:test';
import assert from 'node:assert/strict';
import { albumBatch, fetchAlbumFiles, prefersPhotoLibrary, ALBUM_BATCH_BYTES } from '../../src/features/downloader/lib/media-save.ts';

test('album UI is limited to iPhone and iPad, including desktop-mode iPad',()=>{
  assert.equal(prefersPhotoLibrary({userAgent:'iPhone',platform:'iPhone',maxTouchPoints:5}),true);
  assert.equal(prefersPhotoLibrary({userAgent:'iPad',platform:'iPad',maxTouchPoints:5}),true);
  assert.equal(prefersPhotoLibrary({userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:5}),true);
  assert.equal(prefersPhotoLibrary({userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:0}),false);
  assert.equal(prefersPhotoLibrary({userAgent:'Android',platform:'Linux',maxTouchPoints:5}),false);
  assert.equal(prefersPhotoLibrary({userAgent:'Windows NT 10.0',platform:'Win32',maxTouchPoints:0}),false);
  assert.equal(prefersPhotoLibrary({userAgent:'Windows NT 10.0',platform:'Win32',maxTouchPoints:10}),false);
  assert.equal(prefersPhotoLibrary({userAgent:'iPod',platform:'iPod',maxTouchPoints:5}),false);
});
test('100 selected photos retain order across bounded sharing batches without ZIP or omitted files',()=>{
  const files=Array.from({length:100},(_,index)=>({index,bytes:20*1024**2})),actual=[];
  for(let start=0;start<files.length;){const batch=albumBatch(files,start);assert.ok(batch.length<=10);assert.ok(batch.reduce((n,f)=>n+f.bytes,0)<=ALBUM_BATCH_BYTES);actual.push(...batch);start+=batch.length;}
  assert.deepEqual(actual,files);
  const oversized={index:100,bytes:ALBUM_BATCH_BYTES+1};assert.deepEqual(albumBatch([oversized,...files],0),[oversized]);
});
test('album transfer preserves the real filename, MIME and bytes and reports device transfer progress',async t=>{
  const bytes=new Uint8Array([255,216,255,0,5]),progress=[];
  t.mock.method(globalThis,'fetch',async()=>new Response(bytes,{headers:{'Content-Type':'image/jpeg'}}));
  const files=await fetchAlbumFiles([{url:'/file',name:'照片.jpg',bytes:bytes.length,type:'image/jpeg'}],new AbortController().signal,(...value)=>progress.push(value));
  assert.equal(files[0].name,'照片.jpg');assert.equal(files[0].type,'image/jpeg');assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()),bytes);assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);
});
test('album transfer refuses oversized, truncated and error-page payloads',async t=>{
  const file={url:'/file',name:'video.mp4',bytes:5,type:'video/mp4'},signal=new AbortController().signal;
  const fetch=t.mock.method(globalThis,'fetch',async()=>new Response(new Uint8Array(4),{headers:{'Content-Type':'video/mp4'}}));
  await assert.rejects(fetchAlbumFiles([{...file,bytes:ALBUM_BATCH_BYTES+1}],signal,()=>{}),/较大/);assert.equal(fetch.mock.callCount(),0);
  await assert.rejects(fetchAlbumFiles([file],signal,()=>{}),/完整/);
  fetch.mock.mockImplementation(async()=>new Response('bad',{headers:{'Content-Type':'text/html'}}));
  await assert.rejects(fetchAlbumFiles([file],signal,()=>{}),/传输失败/);
});
