import { alive } from './update-helper.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readSignedManifest, UPDATE_PUBLIC_KEY } from './update-trust.js';

export const UPDATE_REPOSITORY = 'kk12091209/Caibaoliverecorder';
const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export const CAIBAO_UPDATE_URL = 'https://caibao.media/releases/caibo-recorder-update.json';
const DOWNLOAD_ORIGIN = 'https://download.caibao.media';
const COS_ORIGIN = 'https://caibao-releases-1393257344.cos.ap-singapore.myqcloud.com';
const DAY = 86400000, MAX_PACKAGE = 512 * 1024 * 1024;
const CHECK_CACHE_MS = 60000, FAILED_CHECK_RETRY_MS = 10000;
const RATE_LIMIT_MESSAGE = '更新服务暂时限制请求，请等待恢复后重试。';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message),{updateError:true}); };
export function releaseIdentity(value) {
  if (!value || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version) || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 1))) fail('更新版本信息无效。');
  const parts=value.version.split('.').map(Number);
  const legacy=parts[0]===0&&parts[1]===1&&parts[2]<=6;
  return legacy ? `${value.version}-r${value.revision??1}` : value.version;
}
export function newerRelease(candidate, current) {
  releaseIdentity(candidate); releaseIdentity(current);
  const a=candidate.version.split('.').map(Number), b=current.version.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  // Older 0.1.6 installations can still recognize their historical updates.
  return a[0]===0&&a[1]===1&&a[2]<=6&&(candidate.revision??1)>(current.revision??1);
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
  return {key,version:manifest.version,revision:manifest.revision??1,notes:manifest.notes,name,size:item.size,sha256:item.sha256,url:asset.browser_download_url};
}

export function validateMirrorUpdate(envelope, current, platform, publicKey = UPDATE_PUBLIC_KEY) {
  const manifest = readSignedManifest(envelope, publicKey);
  releaseIdentity(manifest);
  const assets = ['win32-x64', 'darwin-arm64'].map(id => {
    const item = manifest.platforms?.[id];
    if (!item || item.name !== packageName(manifest.version, id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_PACKAGE) fail('菜包更新文件信息无效。');
    return { ...item, state: 'uploaded', digest: `sha256:${item.sha256}`, browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${manifest.version}/${item.name}` };
  });
  const next = validateUpdate({ tag_name: `v${manifest.version}`, draft: false, prerelease: false, assets }, manifest, current, platform);
  return next && { ...next, url: `${DOWNLOAD_ORIGIN}/caibo-recorder/${next.version}/${next.name}`, fallbackUrl: next.url };
}

export async function caibaoFetch(url, { fetcher = fetch, signal } = {}) {
  const start = new URL(url);
  const packagePath = /^\/caibo-recorder\/\d{1,5}\.\d{1,5}\.\d{1,5}\/(?:BiliLiveEditor-[\d.]+-win-x64-setup\.exe|Caibo-[\d.]+-macos-arm64\.dmg)$/;
  if (url !== CAIBAO_UPDATE_URL && (start.origin !== DOWNLOAD_ORIGIN || !packagePath.test(start.pathname))) fail('菜包更新地址不受信任。');
  const expectedPath = start.pathname;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = new URL(url);
    if (address.username || address.password || address.search || address.hash || (url !== CAIBAO_UPDATE_URL && (![DOWNLOAD_ORIGIN, COS_ORIGIN].includes(address.origin) || address.pathname !== expectedPath))) fail('菜包更新跳转不受信任。');
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Caibo-Updater', Accept: 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || start.href === CAIBAO_UPDATE_URL) fail('菜包更新跳转无效。');
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); fail('菜包更新源暂时不可用。'); }
    return response;
  }
  fail('菜包更新跳转次数过多。');
}

// Only the project's GitHub endpoint and GitHub's release CDN are contacted.
// Redirects are inspected before following them; no URL comes from the UI.
export async function githubFetch(url,{fetcher=fetch,signal,now=Date.now}={}) {
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
    if(!response.ok){
      const retry=response.headers.get('retry-after'),remaining=response.headers.get('x-ratelimit-remaining');
      let limited=response.status===429||(response.status===403&&(remaining==='0'||retry!==null));
      if(response.status===403&&!limited){
        try{const message=JSON.parse((await boundedBytes(response,16384)).toString('utf8')).message||'';limited=/\brate limit\b|abuse detection/i.test(message);}catch{}
      }else await response.body?.cancel();
      if(limited){
        const time=now(),after=retry!==null&&/^\d+$/.test(retry.trim())?time+Number(retry)*1000:Date.parse(retry??'');
        const reset=remaining==='0'?Number(response.headers.get('x-ratelimit-reset'))*1000:NaN;
        const deadlines=[after,reset].filter(value=>Number.isSafeInteger(value)&&value>time&&value<=8640000000000000);
        throw Object.assign(new Error(RATE_LIMIT_MESSAGE),{updateError:true,retryAt:deadlines.length?Math.max(...deadlines):time+60000});
      }
      fail(response.status===403?'更新服务拒绝了请求（403），请稍后重试或检查网络。':'暂时无法获取更新，请检查网络后重试。');
    }
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
  constructor(store,{current,platform=`${process.platform}-${process.arch}`,fetcher=fetch,now=Date.now,activity=()=>({}),checkTimeoutMs=15000,downloadTimeoutMs=1800000,idleMs=45000,mirror=true,mirrorTimeoutMs=5000,mirrorPublicKey=UPDATE_PUBLIC_KEY}={}) {
    releaseIdentity(current);
    Object.assign(this,{store,current,platform,fetcher,now,activity,checkTimeoutMs,downloadTimeoutMs,idleMs,mirror,mirrorTimeoutMs,mirrorPublicKey});
    this.root=path.join(store.root,'updates');this.status='idle';this.error='';this.candidate=null;this.ready=null;this.received=0;this.closed=false;
    this.checkedAt=store.setting('update-checked-at')||0;
    const retryAt=store.setting('update-retry-at');
    this.retryAt=Number.isSafeInteger(retryAt)&&retryAt>this.now()?retryAt:0;
    this.checkNotice='';this.lastCheckSucceeded=false;
    if(this.retryAt){this.status='error';this.error=RATE_LIMIT_MESSAGE;}
  }
  snapshot(){
    const deferred=this.store.setting('update-deferred');
    return {current:this.current,platform:this.platform,enabled:this.store.setting('update-enabled')!==false,status:this.applying?'installing':this.status,error:this.error,checkedAt:this.checkedAt,checkNotice:this.checkNotice,retryAt:this.retryAt>this.now()?this.retryAt:0,hasCache:!!this.store.setting('update-download'),candidate:this.candidate&&(({url,fallbackUrl,sha256,...visible})=>visible)(this.candidate),received:this.received,deferred:!!(this.candidate&&deferred?.key===this.candidate.key&&deferred.until>this.now()),ignored:!!this.candidate&&this.store.setting('update-ignored-version')===this.candidate.key,autoInstall:!!this.candidate&&this.store.setting('update-auto-install')===this.candidate.key,installBlocked:(this.activity().updateBusy??this.activity().requiresExitConfirmation)?'等待当前录制、导出或素材处理完成后自动更新。':''};
  }
  start(){if(this.started||this.closed)return;this.started=true;this.startTimer=setTimeout(()=>this.autoCheck({startup:true}),5000);this.startTimer.unref?.();this.timer=setInterval(()=>this.autoCheck(),3600000);this.timer.unref?.();}
  autoCheck({startup=false}={}){if(!this.closed&&this.snapshot().enabled&&(startup||this.now()-this.checkedAt>=DAY))return this.check().catch(()=>{});}
  setEnabled(enabled){if(typeof enabled!=='boolean')fail('更新检查设置无效。');const previous=this.snapshot().enabled;this.store.setting('update-enabled',enabled);if(enabled&&!previous&&this.started)void this.autoCheck({startup:true});return this.snapshot();}
  defer(){if(this.candidate)this.store.setting('update-deferred',{key:this.candidate.key,until:this.now()+DAY});return this.snapshot();}
  ignoreVersion(key){
    if(typeof key!=='string'||!this.candidate||key!==this.candidate.key)fail('更新信息已变化，请确认当前版本后重试。');
    this.store.setting('update-ignored-version',key);return this.snapshot();
  }
  check(){
    if(this.closed)fail('软件正在退出。');
    if(this.downloadTask)return Promise.resolve(this.snapshot());
    if(this.checkTask)return this.checkTask;
    if(!this.mirror&&this.retryAt>this.now())return Promise.resolve(this.snapshot());
    const interval=this.lastCheckSucceeded?CHECK_CACHE_MS:FAILED_CHECK_RETRY_MS;
    if(this.lastAttempt!==undefined&&this.now()-this.lastAttempt<interval){
      this.checkNotice=this.lastCheckSucceeded?'刚刚已检查，显示最近的检查结果。':'上次检查未成功，请过几秒再试。';
      return Promise.resolve(this.snapshot());
    }
    this.lastAttempt=this.now();this.status='checking';this.error='';this.checkNotice='';
    this.checkController=new AbortController();
    return this.checkTask=this.checkRemote(AbortSignal.any([this.checkController.signal,AbortSignal.timeout(this.checkTimeoutMs)]))
      .catch(error=>{if(!this.closed){this.lastCheckSucceeded=false;this.retryAt=error.retryAt||0;this.store.setting('update-retry-at',this.retryAt);this.error=error.updateError?error.message:'检查更新失败，请检查网络或稍后重试。';this.status=this.ready?'ready':this.candidate?'available':'error';}return this.snapshot();})
      .finally(()=>{this.checkTask=null;});
  }
  async checkRemote(signal){
    let next;
    if (this.mirror) {
      try {
        const primarySignal = AbortSignal.any([signal, AbortSignal.timeout(this.mirrorTimeoutMs)]);
        const response = await caibaoFetch(CAIBAO_UPDATE_URL, { fetcher: this.fetcher, signal: primarySignal });
        next = validateMirrorUpdate(JSON.parse((await boundedBytes(response, 131072)).toString('utf8')), this.current, this.platform, this.mirrorPublicKey);
      } catch (error) {
        if (signal.aborted || this.closed) throw error;
        next = await this.githubCandidate(signal);
      }
    } else next = await this.githubCandidate(signal);
    this.acceptCandidate(next);
    const saved=this.store.setting('update-download');
    if(next&&saved?.key===next.key&&saved.sha256===next.sha256&&saved.name===next.name){
      const file=path.join(this.root,next.name);
      try{await this.directory();const stat=await fs.lstat(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===next.size)this.ready={...next,file};}catch{}
    }
    this.candidate=next;this.status=next?(this.ready?'ready':'available'):'current';this.checkedAt=this.now();
    this.lastCheckSucceeded=true;this.retryAt=0;this.store.setting('update-retry-at',0);
    this.store.setting('update-checked-at',this.checkedAt);return this.snapshot();
  }
  acceptCandidate(next){
    if(this.candidate?.key!==next?.key||this.candidate?.sha256!==next?.sha256)this.ready=null;
  }
  async githubCandidate(signal){
    if (this.retryAt > this.now()) throw Object.assign(new Error(RATE_LIMIT_MESSAGE), { updateError: true, retryAt: this.retryAt });
    const request=url=>githubFetch(url,{fetcher:this.fetcher,signal,now:this.now});
    const release=JSON.parse((await boundedBytes(await request(RELEASE_API),1024*1024)).toString('utf8'));
    if(release.draft||release.prerelease||!/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(release.tag_name))fail('更新渠道信息无效。');
    const asset=releaseAsset(release,'update-manifest.json');
    if(asset.size>65536)fail('更新清单过大。');
    const bytes=await boundedBytes(await request(asset.browser_download_url),65536);
    if(bytes.length!==asset.size||`sha256:${digest(bytes)}`!==asset.digest)fail('更新清单校验失败。');
    return validateUpdate(release,JSON.parse(bytes.toString('utf8')),this.current,this.platform);
  }
  async directory(){
    // The update cache is fixed under app data; never follow redirected folders.
    for(const directory of [this.root]){
      try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
      const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('更新缓存目录不安全，请检查数据目录。');
    }
    return this.root;
  }
  download(key,autoInstall=false){
    if(this.closed)fail('软件正在退出。');
    if(this.checkTask)fail('正在检查更新，请稍候。');
    if(!this.candidate||key!==this.candidate.key)fail('更新信息已变化，请重新检查。');
    if(autoInstall)this.store.setting('update-auto-install',key);
    if(this.downloadTask)return this.snapshot();
    const candidate={...this.candidate};this.status='downloading';this.error='';this.received=0;this.ready=null;
    this.downloadController=new AbortController();
    this.downloadTask=this.downloadFile(candidate,this.downloadController.signal).catch(error=>{
      if(!this.closed){this.status='available';this.error=this.downloadController.signal.aborted?'下载已取消，可重新下载。':error.message||'下载失败，请重试。';}
    }).finally(()=>{this.downloadTask=null;});
    return this.snapshot();
  }
  async downloadFile(candidate,cancelSignal){
    const urls = [...new Set([candidate.url, candidate.fallbackUrl].filter(Boolean))];
    for (let index = 0; index < urls.length; index++) {
      try { await this.downloadAttempt(candidate, urls[index], cancelSignal); return; }
      catch (error) { if (cancelSignal.aborted || this.closed || index === urls.length - 1) throw error; }
    }
  }
  async downloadAttempt(candidate,url,cancelSignal){
    const directory=await this.directory(),temporary=path.join(directory,randomUUID()+'.part'),file=path.join(directory,candidate.name);
    const idle=new AbortController();let idleTimer;
    this.received = 0;
    const primary = new URL(url).origin === DOWNLOAD_ORIGIN;
    const pulse=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>idle.abort(),primary?Math.min(this.idleMs,15000):this.idleMs);idleTimer.unref?.();};
    const signal=AbortSignal.any([cancelSignal,idle.signal,AbortSignal.timeout(this.downloadTimeoutMs)]);
    let handle;
    try{
      pulse();const response=await (primary?caibaoFetch:githubFetch)(url,{fetcher:this.fetcher,signal});
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
  requestInstall(key=this.candidate?.key){if(!this.ready)fail('请先完成下载。');if(key!==this.candidate?.key)fail('更新信息已变化，请重新检查。');this.store.setting('update-auto-install',this.candidate.key);return this.snapshot();}
  cancel(){this.store.setting('update-auto-install',null);this.downloadController?.abort();return this.snapshot();}
  installPath(){return this.installTask??=this.verifyInstallPath().finally(()=>{this.installTask=null;});}
  async verifyInstallPath(){
    if(this.closed)fail('软件正在退出。');
    if(!this.ready||this.status!=='ready')fail('请先下载并校验更新包。');
    if(this.activity().updateBusy??this.activity().requiresExitConfirmation)fail('等待当前录制、导出或素材处理完成后自动更新。');
    await this.directory();const file=this.ready.file,stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==this.ready.size)fail('更新包发生变化，请重新下载。');
    const hash=createHash('sha256'),handle=await fs.open(file,'r');
    try{for await(const chunk of handle.createReadStream())hash.update(chunk);}finally{await handle.close();}
    if(hash.digest('hex')!==this.ready.sha256)fail('更新包校验失败，请重新下载。');
    if(this.activity().updateBusy??this.activity().requiresExitConfirmation)fail('已有任务开始，请在任务结束后安装。');
    return file;
  }
  async recover(){
    await this.recoverApplication();
    const name=this.store.setting('update-partial');
    if(typeof name==='string'&&/^[a-f0-9-]{36}\.part$/.test(name)){
      try{await this.directory();await fs.unlink(path.join(this.root,name));}catch(e){if(e.code!=='ENOENT')this.error='有未完成的更新缓存，请检查缓存目录。';}
      this.store.setting('update-partial',null);
    }
  }
  async recoverApplication(){
    const applying=this.store.setting('update-application');
    if(!applying?.ticket||!/^[a-f0-9-]{36}$/.test(applying.ticket))return;
    const directory=path.join(this.root,'apply-'+applying.ticket);
    try{
      const result=JSON.parse(await fs.readFile(path.join(directory,'status.json'),'utf8'));
      if(result.status==='error')this.error='自动更新未完成：'+String(result.error).slice(0,400);
      if(['done','error'].includes(result.status)&&Number.isInteger(result.helperPid)&&!alive(result.helperPid)){
        this.store.setting('update-auto-install',null);
        // Keep failure diagnostics; delete only the registered successful cache.
        if(result.status==='done'){const stat=await fs.lstat(directory);if(stat.isDirectory()&&!stat.isSymbolicLink())await fs.rm(directory,{recursive:true});}
        this.store.setting('update-application',null);return;
      }
    }catch{}
    if(!this.closed&&!this.applicationTimer){this.applicationTimer=setTimeout(()=>{this.applicationTimer=null;if(!this.closed)void this.recoverApplication();},3000);this.applicationTimer.unref?.();}
  }
  async clearCache(){
    this.store.setting('update-auto-install',null);
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
  async close(){this.closed=true;clearTimeout(this.startTimer);clearTimeout(this.applicationTimer);clearInterval(this.timer);this.checkController?.abort();this.downloadController?.abort();await Promise.allSettled([this.checkTask,this.downloadTask,this.installTask]);}
}
