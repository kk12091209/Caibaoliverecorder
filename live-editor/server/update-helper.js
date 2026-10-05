// Runs from a private directory outside the installation. No application files
// are removed until both the GUI and backend have exited normally.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export async function digest(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('更新文件类型异常。');const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function run(file,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(file,args,{...options,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>{output=(output+b).slice(-65536);});child.stderr.on('data',b=>{error=(error+b).slice(-8192);});child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(`安装步骤失败 (${code})：${error}`)));});}
export async function atomicReplace(target,stage,backup,{rename=fs.rename,validate=async()=>{}}={}){
  await rename(target,backup);
  try{await rename(stage,target);await validate(target);}catch(error){await fs.rm(target,{recursive:true,force:true});await rename(backup,target);throw error;}
}
export async function waitForExit(pids,{timeout=90000,isAlive=alive,pause=delay,cancelled=async()=>false}={}){
  const deadline=Date.now()+timeout;
  while(pids.some(isAlive)){if(await cancelled())throw new Error('更新已取消。');if(Date.now()>deadline)throw new Error('软件未能安全退出，原版本已保留。');await pause(200);}
  if(await cancelled())throw new Error('更新已取消。');
}
export async function update(requestFile){
  const root=path.dirname(requestFile),request=JSON.parse(await fs.readFile(requestFile,'utf8'));
  const status=async(value)=>{await fs.writeFile(path.join(root,'status.tmp'),JSON.stringify({...value,helperPid:process.pid}));await fs.rename(path.join(root,'status.tmp'),path.join(root,'status.json'));};
  const cancelled=async()=>{try{await fs.access(path.join(root,'cancel'));return true;}catch{return false;}};
  let stage,mounted=false,swapped=false,launched=false,backup;
  const target=path.resolve(request.target),platform=process.platform;
  const relaunch=async()=>platform==='darwin'?run('/usr/bin/open',['-n',...['CAIBO_DATA_ROOT','CAIBO_EXPORT_ROOT','NO_RECORDER'].flatMap(key=>process.env[key]?['--env',key+'='+process.env[key]]:[]),target,'--args','--updated']):new Promise((resolve,reject)=>{const p=spawn(path.join(target,'录播机.exe'),[],{detached:true,stdio:'ignore',windowsHide:false,cwd:target});p.once('error',reject);p.once('spawn',()=>{p.unref();resolve();});});
  try{
    if(request.schema!==1||request.platform!==platform||!['darwin','win32'].includes(platform)||!Number.isInteger(request.guiPid)||request.guiPid<=0||!Number.isInteger(request.backendPid)||request.backendPid<=0||!/^[a-f0-9]{64}$/.test(request.sha256)||!/^\d+\.\d+\.\d+$/.test(request.version)||!Number.isInteger(request.revision)||request.revision<1)throw new Error('更新请求无效。');
    if(await digest(request.package)!==request.sha256)throw new Error('更新包校验失败，原版本已保留。');
    if(platform==='darwin'){
      if(!target.endsWith('.app')||target===path.parse(target).root)throw new Error('安装位置无效。');
      await fs.access(path.dirname(target),fs.constants.W_OK);
      const mount=path.join(root,'mount');await fs.mkdir(mount);
      await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,request.package]);mounted=true;
      const source=path.join(mount,'菜播·录包机.app');
      if(await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(source,'Contents/Info.plist')]).then(s=>s.trim())!=='io.github.kk12091209.caibo')throw new Error('更新包不是本应用。');
      const info=JSON.parse(await fs.readFile(path.join(source,'Contents/Resources/live-editor/package.json'),'utf8'));
      if(info.version!==request.version||(info.buildRevision??1)!==request.revision)throw new Error('更新包版本不匹配。');
      await run('/usr/bin/codesign',['--verify','--deep','--strict',source]);
      stage=path.join(path.dirname(target),`.Caibo-update-${path.basename(root)}.app`);backup=stage+'.backup';
      await fs.lstat(stage).then(()=>{throw new Error('更新暂存目录已存在。');},e=>{if(e.code!=='ENOENT')throw e;});
      // Copy the signed bundle without Finder/resource-fork attributes that ditto
      // can add to a new .app; they invalidate strict bundle verification.
      await run('/usr/bin/ditto',['--norsrc','--noextattr',source,stage]);
      await run('/usr/bin/codesign',['--verify','--deep','--strict',stage]);
      await run('/usr/bin/hdiutil',['detach',mount]);mounted=false;
    }else{
      // Inno Setup installs over the owned installation and preserves its data.
      const marker=await fs.readFile(path.join(target,'程序组件','installation-owner.txt'),'utf8');
      if(!marker.split(/\r?\n/)[1]||path.resolve(marker.split(/\r?\n/)[1]).toLowerCase()!==target.toLowerCase())throw new Error('请先使用安装包安装一次，之后即可在软件内自动更新。');
      if(!request.package.endsWith('-win-x64-setup.exe'))throw new Error('安装包类型无效。');
    }
    await status({status:'ready'});
    await waitForExit([request.guiPid,request.backendPid],{cancelled});
    // Hash again after shutdown: a replaced package must never be executed.
    if(await digest(request.package)!==request.sha256)throw new Error('更新包在安装前发生变化。');
    await status({status:'installing'});
    if(platform==='darwin'){
      await atomicReplace(target,stage,backup,{validate:bundle=>run('/usr/bin/codesign',['--verify','--deep','--strict',bundle])});swapped=true;
    }else{await run(request.package,['/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART','/NOCANCEL','/DIR='+target,'/LOG='+path.join(root,'installer.log')]);}
    await relaunch();launched=true;await status({status:'done',version:request.version,revision:request.revision});
    if(backup)await fs.rm(backup,{recursive:true,force:true}).catch(()=>{});
  }catch(error){
    if(swapped&&!launched&&backup){await fs.rm(target,{recursive:true,force:true});await fs.rename(backup,target);}
    await status({status:'error',error:error.message});
    if(!alive(request.guiPid)&&!alive(request.backendPid))await relaunch().catch(()=>{});
  }finally{
    if(mounted)await run('/usr/bin/hdiutil',['detach',path.join(root,'mount')]).catch(()=>{});
    if(stage)await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await update(process.argv[2]);
