import { acceleratedDownload, downloadAddress, observeDownload } from './downloader-range-transfer.mjs';

self.addEventListener('message',event=>{
  if(event.data?.type==='caibao-transfer-protocol')event.ports[0]?.postMessage('caibao-transfer-v3');
});

// This worker is registered only for /api/downloader/. Normal browsing,
// previews, iOS sharing and unflagged downloads never enter this handler.
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||!['1','2'].includes(url.searchParams.get('parallel'))||!downloadAddress(url.href,self.location.origin))return;
  const id=url.searchParams.get('transfer');
  if(!/^[a-f0-9-]{36}$/.test(id||'')){event.respondWith(acceleratedDownload(event.request));return;}
  let finish;
  const finished=new Promise(resolve=>{finish=resolve;});
  event.waitUntil(finished.then(async()=>{
    // The initiating page is deliberately outside the worker's API scope.
    // Only the page holding this random transfer ID reclaims its own frame.
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clients)client.postMessage({type:'caibao-transfer-complete',id});
  }));
  event.respondWith(acceleratedDownload(event.request).then(response=>observeDownload(response,finish),error=>{finish();throw error;}));
});
