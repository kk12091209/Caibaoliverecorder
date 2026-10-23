import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { createDownloaderApi } from '../../server/downloader/api.mjs';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function fixture(resolver,jobOptions={}){
  let api;
  const server=createServer((req,res)=>void api.handler(req,res,()=>{res.writeHead(404);res.end();}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`,headers={};
  api=createDownloaderApi({resolver,publicOrigins:[base.replace('http:','https:')],jobOptions});
  const close=async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));await api.close();};
  const request=(url,options={})=>fetch(base+url,{...options,headers:{...headers,...options.headers},signal:options.signal||AbortSignal.timeout(5000)});
  try{
  const config=await request('/api/downloader/config');assert.equal(config.status,200);headers.cookie=config.headers.get('set-cookie').split(';')[0];headers['x-downloader-token']=(await config.json()).token;
  const post=async(route,body)=>{const response=await request('/api/downloader/'+route,{method:'POST',body:JSON.stringify(body)});assert.ok(response.ok);return response.json();};
  const session=await post('resolve',{text:'fixture'});
  return {request,post,create:indices=>post('jobs',{sessionId:session.sessionId,indices,delivery:'stream'}),close};
  }catch(error){await close();throw error;}
}
const gallery={platform:'douyin',kind:'images',id:'fixture',title:'中文图文',url:'https://www.douyin.com/',assets:[1,2].map(index=>({index,type:'image',urls:[],title:`图 ${index}`}))};
const video={platform:'bilibili',kind:'video',id:'fixture',title:'中文视频',url:'https://www.bilibili.com/',assets:[{index:1,type:'video'}]};

test('native ZIP headers arrive before preparation; content and resumed ranges remain exact',async()=>{
  const gate=deferred(),input=Buffer.from('original-image-bytes');
  const app=await fixture({resolve:async()=>gallery},{images:{download:async(_urls,{onProgress})=>{await gate.promise;onProgress(input.length,input.length);return {data:input,extension:'jpg',type:'image/jpeg'};}}});
  try{
    const job=await app.create([1,2]);assert.match(job.downloadUrl,/\/stream$/);
    const response=await app.request(job.downloadUrl);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');
    assert.match(response.headers.get('content-disposition'),/^attachment;.*\.zip/);assert.equal(response.headers.get('content-length'),null);
    // Headers may precede queue scheduling as well as media preparation.
    assert.ok(['queued','running'].includes((await (await app.request(`/api/downloader/jobs/${job.id}`)).json()).status));
    let finished=false;const bytes=response.arrayBuffer().then(value=>{finished=true;return Buffer.from(value);});
    let resumed=false;const range=app.request(job.downloadUrl,{headers:{range:'bytes=3-20'}}).then(value=>{resumed=true;return value;});
    await pause(30);assert.equal(finished,false);assert.equal(resumed,false);
    gate.resolve();const archive=await bytes,files=unzipSync(archive);assert.equal(Object.keys(files).length,2);
    for(const value of Object.values(files))assert.deepEqual(Buffer.from(value),input);
    const partial=await range;assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),archive.subarray(3,21));
    const head=await app.request(job.downloadUrl,{method:'HEAD'});assert.equal(Number(head.headers.get('content-length')),archive.length);assert.equal((await head.arrayBuffer()).byteLength,0);
  }finally{gate.resolve();await app.close();}
});

test('an early video attachment aborts on source failure instead of completing a zero-byte MP4',async()=>{
  const gate=deferred();
  const app=await fixture({resolve:async()=>video,bilibiliStreams:async()=>{await gate.promise;throw new Error('源文件不可用');}});
  try{
    const job=await app.create([1]);
    const other=await app.request(job.downloadUrl,{headers:{cookie:''}});assert.equal(other.status,401);assert.equal(other.headers.get('content-disposition'),null);
    const response=await app.request(job.downloadUrl);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'video/mp4');
    const body=response.arrayBuffer();gate.resolve();await assert.rejects(body);
    const failed=await app.request(job.downloadUrl);assert.equal(failed.status,409);assert.match((await failed.json()).error,/不可用/);
  }finally{gate.resolve();await app.close();}
});

test('cancelling preparation breaks an accepted attachment and reports cancellation',async()=>{
  const gate=deferred();
  const app=await fixture({resolve:async()=>video,bilibiliStreams:async()=>{await gate.promise;throw new Error('cancelled');}});
  try{
    const job=await app.create([1]),response=await app.request(job.downloadUrl),body=response.arrayBuffer();
    const broken=assert.rejects(body);await app.post(`jobs/${job.id}/cancel`,{});await broken;
    assert.equal((await (await app.request(`/api/downloader/jobs/${job.id}`)).json()).status,'cancelled');
  }finally{gate.resolve();await app.close();}
});

test('a single transparent image waits for its real PNG format, never a misleading JPG header',async()=>{
  const gate=deferred(),png=Buffer.from('png-image-bytes');
  const app=await fixture({resolve:async()=>gallery},{images:{download:async(_urls,{onProgress})=>{await gate.promise;onProgress(png.length,png.length);return {data:png,extension:'png',type:'image/png'};}}});
  try{
    const job=await app.create([1]);assert.match(job.downloadUrl,/\/download$/);
    let accepted=false;const waiting=app.request(job.downloadUrl).then(value=>{accepted=true;return value;});await pause(30);assert.equal(accepted,false);
    gate.resolve();const response=await waiting;assert.equal(response.headers.get('content-type'),'image/png');assert.match(response.headers.get('content-disposition'),/\.png/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  }finally{gate.resolve();await app.close();}
});
