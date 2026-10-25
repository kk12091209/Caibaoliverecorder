import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { acceleratedDownload, downloadAddress } from '../../public/downloader-range-transfer.mjs';
import { supportsParallelDownload } from '../../src/features/downloader/lib/desktop-download.ts';

const origin='https://caibao.media',job='a'.repeat(36),file='b'.repeat(36),url=`${origin}/api/downloader/jobs/${job}/files/${file}?download=1&parallel=1`;
const request=()=>new Request(url);
const data=Uint8Array.from({length:1024*1024+173},(_,i)=>(i*17)%251);
const hash=value=>createHash('sha256').update(value).digest('hex');
function source(options={}){
  const calls=[],attempts=new Map();let active=0,maximum=0;
  const fetcher=async(target,init={})=>{
    const range=new Headers(init.headers).get('range');calls.push({target,range,signal:init.signal});
    const headers={'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="proof.mp4"','Content-Length':String(data.length),'Accept-Ranges':'bytes',ETag:'"stable"'};
    if(!range||options.ignore)return new Response(data,{headers});
    const match=/^bytes=(\d+)-(\d+)$/.exec(range),start=Number(match[1]),end=Number(match[2]);
    attempts.set(start,(attempts.get(start)||0)+1);
    active++;maximum=Math.max(maximum,active);
    try{
      if(end>0)await pause(options.delay??(start%3+1)*3,undefined,{signal:init.signal});
      const truncate=options.truncate&&end>0&&attempts.get(start)===1;
      const body=data.subarray(start,end+1-(truncate?1:0));
      if(options.stall&&end>0&&attempts.get(start)===1)await pause(1000,undefined,{signal:init.signal});
      return new Response(body,{status:206,headers:{...headers,'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${options.wrongTotal&&end>0?data.length+1:data.length}`,ETag:options.changed&&end>0?'"changed"':'"stable"'}});
    }finally{active--;}
  };
  return {fetcher,calls,attempts,get active(){return active;},get maximum(){return maximum;}};
}
const settings={minBytes:10,chunkBytes:64*1024,idleMs:500};

test('desktop acceleration is limited to desktop Chromium; phone and Safari stay native',()=>{
  assert.equal(supportsParallelDownload({userAgent:'Windows NT 10.0 Chrome/140.0'}),true);
  assert.equal(supportsParallelDownload({userAgent:'Macintosh Chrome/140.0'}),true);
  assert.equal(supportsParallelDownload({userAgent:'Windows NT 10.0 Chrome/140.0 Edg/140.0'}),true);
  for(const userAgent of ['Android Chrome/140.0','iPhone CriOS/140.0','Macintosh Version/26.0 Safari/605','iPad Chrome/140.0','Firefox/140.0'])assert.equal(supportsParallelDownload({userAgent}),false);
});
test('worker address validation rejects external origins, arbitrary paths and malformed IDs',()=>{
  assert.equal(downloadAddress(url,origin).job,job);
  for(const value of ['https://example.com'+new URL(url).pathname,'/api/downloader/config','/api/downloader/jobs/short/download','/api/downloader/jobs/'+job+'/files/../config'])assert.equal(downloadAddress(value,origin),null);
});
test('archive-aware worker accepts both protocol versions and leaves ordinary downloads untouched',()=>{
  let handler;const handled=[];
  const source=readFileSync(new URL('../../public/downloader-transfer-worker.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
  runInNewContext(source,{URL,downloadAddress,acceleratedDownload:request=>{handled.push(request.url);return 'stream';},self:{location:{origin},addEventListener:(type,callback)=>{assert.equal(type,'fetch');handler=callback;}}});
  const dispatch=(target,method='GET')=>{let response;handler({request:new Request(target,{method}),respondWith:value=>{response=value;}});return response;};
  for(const version of ['1','2'])assert.equal(dispatch(`${origin}/api/downloader/jobs/${job}/stream?parallel=${version}`),'stream');
  for(const target of [`${origin}/api/downloader/jobs/${job}/stream`,`${origin}/api/downloader/jobs/${job}/stream?parallel=3`,`${origin}/api/downloader/config?parallel=2`,`https://foreign.example/api/downloader/jobs/${job}/stream?parallel=2`])assert.equal(dispatch(target),undefined);
  assert.equal(dispatch(`${origin}/api/downloader/jobs/${job}/stream?parallel=2`,'POST'),undefined);assert.equal(handled.length,2);
});
test('out-of-order parallel chunks produce byte-exact native response headers with bounded prefetch',async()=>{
  const fake=source(),response=await acceleratedDownload(request(),{...settings,fetcher:fake.fetcher});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(data.length));assert.equal(response.headers.get('content-range'),null);assert.match(response.headers.get('content-disposition'),/proof.mp4/);
  const reader=response.body.getReader(),pieces=[];
  pieces.push((await reader.read()).value);assert.equal(pieces[0].length,1,'the validated prefix starts the native download without waiting for a whole segment');
  pieces.push((await reader.read()).value);await pause(30);
  assert.equal(fake.calls.length,4,'one probe and only three prefetched ranges while the consumer is paused');
  for(;;){const item=await reader.read();if(item.done)break;pieces.push(item.value);}
  assert.equal(hash(Buffer.concat(pieces)),hash(data));assert.equal(fake.maximum,3);assert.equal(fake.active,0);
});
test('truncated segments retry only their own range and never append duplicate bytes',async()=>{
  const fake=source({truncate:true}),response=await acceleratedDownload(request(),{...settings,fetcher:fake.fetcher});
  assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));
  assert.ok([...fake.attempts.values()].some(value=>value===2));assert.equal(fake.active,0);
});
test('stalled connections are aborted and replaced without restarting the file',async()=>{
  const fake=source({stall:true,delay:0}),response=await acceleratedDownload(request(),{...settings,idleMs:20,fetcher:fake.fetcher});
  assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));assert.equal(fake.active,0);
});
for(const failure of ['wrongTotal','changed'])test(`${failure} cannot silently corrupt a download`,async()=>{
  const fake=source({[failure]:true}),response=await acceleratedDownload(request(),{...settings,retries:0,fetcher:fake.fetcher});
  await assert.rejects(response.arrayBuffer(),/不一致|变化/);await pause(10);assert.equal(fake.active,0);
});
test('servers that ignore Range fall back to their original streaming body',async()=>{
  const fake=source({ignore:true}),response=await acceleratedDownload(request(),{...settings,fetcher:fake.fetcher});
  assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));assert.equal(fake.calls.length,1);
});
for(const route of ['stream','download'])test(`completed ${route} redirect keeps native attachment headers and bytes without a redirected navigation response`,async()=>{
  const fetcher=async()=>{
    const response=new Response(data,{headers:{'Content-Type':'video/mp4','Content-Length':String(data.length),'Content-Disposition':'attachment; filename="ready.mp4"'}});
    Object.defineProperty(response,'redirected',{value:true});return response;
  };
  const response=await acceleratedDownload(new Request(`${origin}/api/downloader/jobs/${job}/${route}?parallel=2`),{fetcher});
  assert.equal(response.redirected,false);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/ready.mp4/);assert.equal(Number(response.headers.get('content-length')),data.length);
  assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));
});
test('browser cancellation aborts every outstanding segment without issuing a fallback download',async()=>{
  const fake=source({delay:40}),response=await acceleratedDownload(request(),{...settings,fetcher:fake.fetcher}),reader=response.body.getReader();
  await reader.read();const reading=reader.read();await pause(5);await reader.cancel();await reading;
  assert.equal(fake.calls.length,4);assert.equal(fake.active,0);assert.ok(fake.calls.every(call=>call.signal.aborted));
});
test('a browser resume Range is passed directly to the authenticated server',async()=>{
  const fake=source(),resumed=new Request(url,{headers:{Range:'bytes=5-100','If-Range':'"stable"'}});
  const response=await acceleratedDownload(resumed,{...settings,fetcher:fake.fetcher});
  assert.equal(response.status,206);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),data.subarray(5,101));assert.equal(fake.calls.length,1);
});
test('a growing Bilibili stream starts immediately then switches to exact remaining ranges when ready',async()=>{
  const prefix=data.subarray(0,12345);let cancelled=false,polls=0;const fake=source();
  const fetcher=async(target,init)=>{
    if(target.endsWith('/stream'))return new Response(new ReadableStream({start(controller){controller.enqueue(prefix);},cancel(){cancelled=true;}}),{headers:{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="movie.mp4"'}});
    if(target.endsWith('/'+job)){polls++;return Response.json(polls===1?{status:'running'}:{status:'done',files:[{type:'video/mp4',bytes:data.length,url:new URL(url).pathname+'?download=1'}]});}
    return fake.fetcher(target,init);
  };
  const response=await acceleratedDownload(new Request(`${origin}/api/downloader/jobs/${job}/stream?parallel=1`),{...settings,pollMs:10,fetcher});
  assert.equal(response.headers.get('content-length'),null);const reader=response.body.getReader();
  const first=await reader.read();assert.deepEqual(first.value,prefix);assert.equal(polls,1);
  const output=[first.value];for(;;){const item=await reader.read();if(item.done)break;output.push(item.value);}
  assert.equal(hash(Buffer.concat(output)),hash(data));assert.equal(cancelled,true);assert.match(fake.calls[0].range,/bytes=12345-/);
});
test('status lookup failure leaves the existing Bilibili stream intact',async()=>{
  const fetcher=async target=>{if(target.endsWith('/stream'))return new Response(data,{headers:{'Content-Type':'video/mp4'}});throw new Error('status unavailable');};
  const response=await acceleratedDownload(new Request(`${origin}/api/downloader/jobs/${job}/stream?parallel=1`),{...settings,fetcher});
  assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));
});
test('an early ZIP download switches to the archive, never the first MP4 in a mixed selection',async()=>{
  const fake=source(),archivePath=`/api/downloader/jobs/${job}/files/${'c'.repeat(36)}?download=1`;let cancelled=false;
  const fetcher=async(target,init)=>{
    if(target.endsWith('/stream'))return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="selected.zip"'}});
    if(target.endsWith('/'+job))return Response.json({status:'done',archive:{url:archivePath,bytes:data.length},files:[{url:new URL(url).pathname,type:'video/mp4',bytes:400}]});
    assert.equal(new URL(target).pathname,new URL(archivePath,origin).pathname);return fake.fetcher(target,init);
  };
  const response=await acceleratedDownload(new Request(`${origin}/api/downloader/jobs/${job}/stream?parallel=1`),{...settings,fetcher});
  assert.equal(response.headers.get('content-type'),'application/zip');assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(data));assert.equal(cancelled,true);
});
