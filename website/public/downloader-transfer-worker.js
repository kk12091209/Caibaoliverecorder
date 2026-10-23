import { acceleratedDownload, downloadAddress } from './downloader-range-transfer.mjs';

// This worker is registered only for /api/downloader/. Normal browsing,
// previews, iOS sharing and unflagged downloads never enter this handler.
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||!['1','2'].includes(url.searchParams.get('parallel'))||!downloadAddress(url.href,self.location.origin))return;
  event.respondWith(acceleratedDownload(event.request));
});
