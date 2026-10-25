// Runs in the download worker, not the page. Never persist media or buffer a movie.
const MiB=1024**2;
const jobPath=/^\/api\/downloader\/jobs\/([a-f0-9]{36})\/(download|stream|files\/[a-f0-9]{36})$/;
export function downloadAddress(value,origin){
  const url=new URL(value,origin),match=jobPath.exec(url.pathname);
  if(url.origin!==origin||!match)return null;
  url.searchParams.delete('parallel');
  return {url:url.href,job:match[1],stream:match[2]==='stream'};
}
function rangeInfo(response){
  const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
  if(!match)return null;
  const [start,end,total]=match.slice(1).map(Number);
  return [start,end,total].every(Number.isSafeInteger)&&start<=end&&end<total?{start,end,total}:null;
}
function responseHeaders(response,total){
  const headers=new Headers(response.headers);
  for(const key of ['content-range','content-encoding','transfer-encoding'])headers.delete(key);
  if(total!==undefined)headers.set('Content-Length',String(total));
  else headers.delete('Content-Length');
  headers.set('Cache-Control','private, no-store');
  return headers;
}
function attachmentResponse(response){
  // A job can finish between creating /stream and opening it. Fetch follows
  // its redirect, but Chrome cannot use that redirected response for a worker
  // navigation. Wrap the same stream and headers without buffering the file.
  return response.redirected?new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers}):response;
}

export async function acceleratedDownload(request,{fetcher=fetch,parallel=3,minBytes=2*MiB,chunkBytes,idleMs=12000,retries=2,pollMs=4000}={}){
  const origin=new URL(request.url).origin,address=downloadAddress(request.url,origin);
  if(!address)throw new Error('Invalid download address');
  const direct=async()=>attachmentResponse(await fetcher(address.url,{credentials:'same-origin',cache:'no-store',headers:request.headers,signal:request.signal}));
  if(request.method!=='GET'||request.headers.has('range'))return direct();
  const operation=new AbortController(),signal=operation.signal;
  const abort=()=>operation.abort(request.signal.reason);
  request.signal.addEventListener('abort',abort,{once:true});
  if(request.signal.aborted)abort();
  const finish=()=>{operation.abort();request.signal.removeEventListener('abort',abort);};
  const wait=ms=>new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
    signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted)stop();
  });
  async function piece(url,start,end,total,etag){
    let error;
    for(let attempt=0;attempt<=retries;attempt++){
      signal.throwIfAborted();
      const timeout=new AbortController(),combined=AbortSignal.any([signal,timeout.signal]);let timer,response,reader;
      const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>timeout.abort(new Error('下载分段停滞')),idleMs);};
      try{
        touch();
        const headers={Range:`bytes=${start}-${end}`};if(etag&&!etag.startsWith('W/'))headers['If-Range']=etag;
        response=await fetcher(url,{headers,credentials:'same-origin',cache:'no-store',signal:combined});
        const range=rangeInfo(response);
        if(response.status!==206||!range||range.start!==start||range.end!==end||range.total!==total)throw new Error('下载分段范围不一致');
        if(etag&&response.headers.get('etag')!==etag)throw new Error('下载文件发生变化');
        const length=Number(response.headers.get('content-length'));
        if(response.headers.has('content-length')&&length!==end-start+1)throw new Error('下载分段长度不一致');
        const output=new Uint8Array(end-start+1);let offset=0;reader=response.body.getReader();
        for(;;){const {done,value}=await reader.read();if(done)break;touch();if(offset+value.length>output.length)throw new Error('下载分段超出范围');output.set(value,offset);offset+=value.length;}
        if(offset!==output.length)throw new Error('下载分段不完整');
        return output;
      }catch(reason){
        error=reason;if(signal.aborted)throw signal.reason;
        if([401,403,404,410,416].includes(response?.status))throw reason;
      }finally{
        clearTimeout(timer);timeout.abort();
        await (reader?reader.cancel():response?.body?.cancel())?.catch(()=>{});
      }
      if(attempt<retries)await wait(200*(attempt+1));
    }
    throw error;
  }
  async function* parts(url,start,total,etag){
    // At most 64 ranges within the public 1 GiB limit; bound memory for larger local files.
    const size=chunkBytes||Math.min(16*MiB,Math.max(MiB,Math.ceil(total/64/(256*1024))*256*1024));
    const window=[];let next=start;
    const fill=()=>{while(window.length<parallel&&next<total){const begin=next,end=Math.min(total-1,next+size-1);next=end+1;window.push(piece(url,begin,end,total,etag).then(value=>({value}),error=>({error})));}};
    try{
      fill();
      while(window.length){const result=await window.shift();if(result.error)throw result.error;yield result.value;fill();}
    }finally{finish();await Promise.all(window);}
  }
  function asResponse(iterator,headers){
    const body=new ReadableStream({
      async pull(controller){try{const item=await iterator.next();if(item.done){finish();controller.close();}else controller.enqueue(item.value);}catch(error){finish();controller.error(error);}},
      async cancel(){finish();await iterator.return?.();},
    },{highWaterMark:0});
    return new Response(body,{status:200,headers});
  }
  try{
    // Accept attachment headers without a HEAD request or waiting for preparation.
    if(address.stream){
      const initial=await fetcher(address.url,{credentials:'same-origin',cache:'no-store',signal});
      const total=Number(initial.headers.get('content-length'));
      if(!initial.ok||!initial.body||total&&total<minBytes){request.signal.removeEventListener('abort',abort);return attachmentResponse(initial);}
      if(total>0&&initial.headers.get('accept-ranges')==='bytes'){
        const resolved=downloadAddress(initial.url||address.url,origin);
        if(!resolved||resolved.job!==address.job)throw new Error('下载地址不一致');
        await initial.body.cancel();return asResponse(parts(resolved.url,0,total,initial.headers.get('etag')),responseHeaders(initial,total));
      }
      const reader=initial.body.getReader();let ready=null,notifyReady;
      const available=new Promise(resolve=>{notifyReady=resolve;}),readyEvent=available.then(()=>({ready:true}));
      const poll=(async()=>{
        try{while(!signal.aborted){
          const response=await fetcher(`${origin}/api/downloader/jobs/${address.job}`,{credentials:'same-origin',cache:'no-store',signal});
          if(!response.ok)return;
          const state=await response.json();if(['failed','cancelled'].includes(state.status))return;
          if(state.status==='done'){
            const type=initial.headers.get('content-type')?.split(';')[0];
            const file=type==='application/zip'?state.archive:type==='video/mp4'&&!state.archive?state.files?.find(file=>file.type==='video/mp4'):null,target=file&&downloadAddress(file.url,origin);
            if(target?.job===address.job&&Number.isSafeInteger(file.bytes)&&file.bytes>0){ready={url:target.url,total:file.bytes};notifyReady();}
            return;
          }
          await wait(pollMs);
        }}catch{/* The original stream remains usable when status polling fails. */}
      })();
      const iterator=(async function*(){let position=0,pending;
        try{for(;;){
          if(ready){
            await reader.cancel();
            if(position>ready.total)throw new Error('文件长度不一致');
            if(position<ready.total)yield* parts(ready.url,position,ready.total,null);
            return;
          }
          pending??=reader.read().then(value=>({value}));
          const item=await Promise.race([pending,readyEvent]);
          if(item.ready)continue;
          pending=null;if(item.value.done)return;
          position+=item.value.value.length;yield item.value.value;
        }}finally{finish();await reader.cancel().catch(()=>{});await poll;}
      })();
      return asResponse(iterator,responseHeaders(initial));
    }
    // A one-byte probe gets the actual immutable size, filename and validator.
    const probe=await fetcher(address.url,{headers:{Range:'bytes=0-0'},credentials:'same-origin',cache:'no-store',signal});
    const range=rangeInfo(probe);
    if(probe.status===200){request.signal.removeEventListener('abort',abort);return attachmentResponse(probe);}
    if(probe.status!==206||!range||range.start!==0||range.end!==0||range.total<minBytes){await probe.body?.cancel();finish();return direct();}
    const prefix=new Uint8Array(await probe.arrayBuffer());
    if(prefix.length!==1){finish();return direct();}
    // Give the native download manager its first byte immediately, even when a
    // whole segment takes seconds to arrive over a slow proxy connection.
    const iterator=(async function*(){try{yield prefix;yield* parts(address.url,1,range.total,probe.headers.get('etag'));}finally{finish();}})();
    return asResponse(iterator,responseHeaders(probe,range.total));
  }catch(error){finish();if(request.signal.aborted)throw error;return direct();}
}
