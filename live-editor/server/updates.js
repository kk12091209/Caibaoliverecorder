import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const UPDATE_REPOSITORY = 'kk12091209/Caibaoliverecorder';
const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const DAY = 86400000, MAX_PACKAGE = 512 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message),{updateError:true}); };
export function releaseIdentity(value) {
  if (!value || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version) || !Number.isSafeInteger(value.revision) || value.revision < 1) fail('更新版本信息无效。');
  return `${value.version}-r${value.revision}`;
}
export function newerRelease(candidate, current) {
  releaseIdentity(candidate); releaseIdentity(current);
  const a=candidate.version.split('.').map(Number), b=current.version.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return candidate.revision>current.revision;
}
export function packageName(version, platform) {
  return platform==='win32-x64' ? `BiliLiveEditor-${version}-win-x64-setup.exe` : platform==='darwin-arm64' ? `Caibo-${version}-macos-arm64.dmg` : '';
}
function releaseAsset(release, name) {
  const items=release.assets?.filter(asset=>asset.name===name);
  if(items?.length!==1)fail('发布附件尚未准备完整，请稍后检查。');
  const asset=items[0];
  const expected=`https://github.com/${UPDATE_REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if(asset.state!=='uploaded'||asset.browser_download_url!==expected||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||!Number.isSafeInteger(asset.size)||asset.size<=0)fail('发布附件校验信息无效。');
  return asset;
}
export function validateUpdate(release, manifest, current, platform) {
  const key=releaseIdentity(manifest);
  if(manifest.schema!==1||release.draft||release.prerelease||release.tag_name!==`v${manifest.version}`)fail('更新渠道信息无效。');
  if(!newerRelease(manifest,current))return null;
  const item=manifest.platforms?.[platform],name=packageName(manifest.version,platform);
  if(!name||!item||item.name!==name||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.size)||item.size<=0||item.size>MAX_PACKAGE)fail('尚无适用于当前系统的更新包。');
  const asset=releaseAsset(release,name);
  if(asset.digest!==`sha256:${item.sha256}`||asset.size!==item.size)fail('安装包与更新清单不一致，请稍后检查。');
  if(!Array.isArray(manifest.notes)||manifest.notes.length>12||manifest.notes.some(note=>typeof note!=='string'||note.length>500))fail('更新说明无效。');
  return {key,version:manifest.version,revision:manifest.revision,notes:manifest.notes,name,size:item.size,sha256:item.sha256,url:asset.browser_download_url};
}

// Only the project's GitHub endpoint and GitHub's release CDN are contacted.
// Redirects are inspected before following them; no URL comes from the UI.
export async function githubFetch(url,{fetcher=fetch,signal}={}) {
  for(let redirects=0;redirects<=5;redirects++){
    const address=new URL(url);
    const api=address.origin==='https://api.github.com'&&address.pathname===`/repos/${UPDATE_REPOSITORY}/releases/latest`;
    const release=address.origin==='https://github.com'&&address.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`);
    const cdn=['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(address.hostname)&&address.protocol==='https:'&&!address.port;
    if(address.username||address.password||(!api&&!release&&!cdn))fail('更新下载地址不受信任。');
    const response=await fetcher(url,{redirect:'manual',signal,headers:{'User-Agent':'Caibo-Updater','Accept':api?'application/vnd.github+json':'application/octet-stream'}});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)fail('更新下载跳转无效。');url=new URL(location,url).href;continue;
    }
    if(!response.ok){await response.body?.cancel();fail(response.status===403||response.status===429?'检查更新过于频繁，请稍后重试。':'暂时无法获取更新，请检查网络后重试。');}
    return response;
  }
  fail('更新下载跳转次数过多。');
}
async function boundedBytes(response,limit) {
  let length=0;const chunks=[];
  try{for await(const chunk of response.body){length+=chunk.length;if(length>limit)fail('更新信息过大，已停止读取。');chunks.push(chunk);}}
  catch(error){await response.body?.cancel().catch(()=>{});throw error;}
  return Buffer.concat(chunks);
}

export class Updates {
  constructor(store,{current,platform=`${process.platform}-${process.arch}`,fetcher=fetch,now=Date.now,activity=()=>({}),checkTimeoutMs=15000,downloadTimeoutMs=1800000,idleMs=45000}={}) {
    releaseIdentity(current);
    Object.assign(this,{store,current,platform,fetcher,now,activity,checkTimeoutMs,downloadTimeoutMs,idleMs});
    this.root=path.join(store.root,'updates');this.status='idle';this.error='';this.candidate=null;this.ready=null;this.received=0;this.closed=false;
    this.checkedAt=store.setting('update-checked-at')||0;
  }
  snapshot(){
    const deferred=this.store.setting('update-deferred');
    return {current:this.current,platform:this.platform,enabled:this.store.setting('update-enabled')!==false,status:this.status,error:this.error,checkedAt:this.checkedAt,hasCache:!!this.store.setting('update-download'),candidate:this.candidate&&(({url,sha256,...visible})=>visible)(this.candidate),received:this.received,deferred:!!(this.candidate&&deferred?.key===this.candidate.key&&deferred.until>this.now()),installBlocked:this.activity().requiresExitConfirmation?'请先停止录制，并等待导出完成。':''};
  }
  start(){this.startTimer=setTimeout(()=>this.autoCheck(),5000);this.startTimer.unref?.();this.timer=setInterval(()=>this.autoCheck(),3600000);this.timer.unref?.();}
  autoCheck(){if(!this.closed&&this.snapshot().enabled&&this.now()-this.checkedAt>=DAY)void this.check().catch(()=>{});}
  setEnabled(enabled){if(typeof enabled!=='boolean')fail('更新检查设置无效。');this.store.setting('update-enabled',enabled);return this.snapshot();}
  defer(){if(this.candidate)this.store.setting('update-deferred',{key:this.candidate.key,until:this.now()+DAY});return this.snapshot();}
  check(){
    if(this.closed)fail('软件正在退出。');
    if(this.downloadTask)return Promise.resolve(this.snapshot());
    if(this.checkTask)return this.checkTask;
    if(this.lastAttempt&&this.now()-this.lastAttempt<60000)return Promise.resolve(this.snapshot());
    this.lastAttempt=this.now();this.status='checking';this.error='';
    this.checkController=new AbortController();
    return this.checkTask=this.checkRemote(AbortSignal.any([this.checkController.signal,AbortSignal.timeout(this.checkTimeoutMs)]))
      .catch(error=>{if(!this.closed){this.error=error.updateError?error.message:'检查更新失败，请检查网络或稍后重试。';this.status=this.ready?'ready':this.candidate?'available':'error';}return this.snapshot();})
      .finally(()=>{this.checkTask=null;});
  }
  async checkRemote(signal){
    const request=url=>githubFetch(url,{fetcher:this.fetcher,signal});
    const release=JSON.parse((await boundedBytes(await request(RELEASE_API),1024*1024)).toString('utf8'));
    if(release.draft||release.prerelease||!/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(release.tag_name))fail('更新渠道信息无效。');
    const asset=releaseAsset(release,'update-manifest.json');
    if(asset.size>65536)fail('更新清单过大。');
    const bytes=await boundedBytes(await request(asset.browser_download_url),65536);
    if(bytes.length!==asset.size||`sha256:${digest(bytes)}`!==asset.digest)fail('更新清单校验失败。');
    const next=validateUpdate(release,JSON.parse(bytes.toString('utf8')),this.current,this.platform);
    if(this.candidate?.key!==next?.key||this.candidate?.sha256!==next?.sha256)this.ready=null;
    const saved=this.store.setting('update-download');
    if(next&&saved?.key===next.key&&saved.sha256===next.sha256&&saved.name===next.name){
      const file=path.join(this.root,next.name);
      try{await this.directory();const stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===next.size)this.ready={...next,file};}catch{}
    }
    this.candidate=next;this.status=next?(this.ready?'ready':'available'):'current';this.checkedAt=this.now();
    this.store.setting('update-checked-at',this.checkedAt);return this.snapshot();
  }
  async directory(){
    // The update cache is fixed under app data; never follow redirected folders.
    for(const directory of [this.root]){
      try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
      const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('更新缓存目录不安全，请检查数据目录。');
    }
    return this.root;
  }
  download(key){
    if(this.closed)fail('软件正在退出。');
    if(this.checkTask)fail('正在检查更新，请稍候。');
    if(!this.candidate||key!==this.candidate.key)fail('更新信息已变化，请重新检查。');
    if(this.downloadTask)return this.snapshot();
    const candidate={...this.candidate};this.status='downloading';this.error='';this.received=0;this.ready=null;
    this.downloadController=new AbortController();
    this.downloadTask=this.downloadFile(candidate,this.downloadController.signal).catch(error=>{
      if(!this.closed){this.status='available';this.error=this.downloadController.signal.aborted?'下载已取消，可重新下载。':error.message||'下载失败，请重试。';}
    }).finally(()=>{this.downloadTask=null;});
    return this.snapshot();
  }
  async downloadFile(candidate,cancelSignal){
    const directory=await this.directory(),temporary=path.join(directory,randomUUID()+'.part'),file=path.join(directory,candidate.name);
    const idle=new AbortController();let idleTimer;
    const pulse=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>idle.abort(),this.idleMs);idleTimer.unref?.();};
    const signal=AbortSignal.any([cancelSignal,idle.signal,AbortSignal.timeout(this.downloadTimeoutMs)]);
    let handle;
    try{
      pulse();const response=await githubFetch(candidate.url,{fetcher:this.fetcher,signal});
      this.store.setting('update-partial',path.basename(temporary));
      handle=await fs.open(temporary,'wx',0o600);const hash=createHash('sha256');
      for await(const bytes of response.body){
        signal.throwIfAborted();this.received+=bytes.length;
        if(this.received>candidate.size)fail('更新包大小不符，已停止下载。');
        hash.update(bytes);await handle.writeFile(bytes);pulse();
      }
      signal.throwIfAborted();
      if(this.received!==candidate.size||hash.digest('hex')!==candidate.sha256)fail('更新包校验失败，请重新下载。');
      await handle.sync();await handle.close();handle=null;
      // Refuse unusual cache entries instead of replacing an external target.
      try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail('更新缓存文件异常。');await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
      await fs.rename(temporary,file);this.ready={...candidate,file};this.store.setting('update-download',{key:candidate.key,version:candidate.version,revision:candidate.revision,name:candidate.name,sha256:candidate.sha256});this.status='ready';this.error='';
    }catch(error){if(signal.aborted&&!cancelSignal.aborted)fail('下载连接中断或超时，请重试。');throw error;}
    finally{clearTimeout(idleTimer);await handle?.close();await fs.rm(temporary,{force:true});this.store.setting('update-partial',null);}
  }
  cancel(){this.downloadController?.abort();return this.snapshot();}
  installPath(){return this.installTask??=this.verifyInstallPath().finally(()=>{this.installTask=null;});}
  async verifyInstallPath(){
    if(this.closed)fail('软件正在退出。');
    if(!this.ready||this.status!=='ready')fail('请先下载并校验更新包。');
    if(this.activity().requiresExitConfirmation)fail('请先停止录制，并等待导出完成。');
    await this.directory();const file=this.ready.file,stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.ready.size)fail('更新包发生变化，请重新下载。');
    const hash=createHash('sha256'),handle=await fs.open(file,'r');
    try{for await(const chunk of handle.createReadStream())hash.update(chunk);}finally{await handle.close();}
    if(hash.digest('hex')!==this.ready.sha256)fail('更新包校验失败，请重新下载。');
    if(this.activity().requiresExitConfirmation)fail('已有任务开始，请在任务结束后安装。');
    return file;
  }
  async recover(){
    const name=this.store.setting('update-partial');
    if(typeof name==='string'&&/^[a-f0-9-]{36}\.part$/.test(name)){
      try{await this.directory();await fs.unlink(path.join(this.root,name));}catch(e){if(e.code!=='ENOENT')this.error='有未完成的更新缓存，请检查缓存目录。';}
      this.store.setting('update-partial',null);
    }
  }
  async clearCache(){
    if(this.downloadTask||this.installTask||this.checkTask)fail('更新任务正在进行，请稍后清理。');
    const saved=this.store.setting('update-download');
    if(saved){
      releaseIdentity(saved);if(saved.name!==packageName(saved.version,this.platform))fail('更新缓存记录无效。');
      await this.directory();const file=path.join(this.root,saved.name);
      try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail('更新缓存文件异常。');await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
      this.store.setting('update-download',null);
    }
    this.ready=null;if(this.status==='ready')this.status='available';return this.snapshot();
  }
  async close(){this.closed=true;clearTimeout(this.startTimer);clearInterval(this.timer);this.checkController?.abort();this.downloadController?.abort();await Promise.allSettled([this.checkTask,this.downloadTask,this.installTask]);}
}
