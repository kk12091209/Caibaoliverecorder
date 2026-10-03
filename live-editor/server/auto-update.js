import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { delay, alive } from './update-helper.js';
export class AutoUpdate{
  constructor({updates,runtime,appRoot,projectRoot,activity,quit}){Object.assign(this,{updates,runtime,appRoot,projectRoot,activity,quit});this.applying=false;}
  async cancel(){if(this.applicationRoot)await fs.writeFile(path.join(this.applicationRoot,'cancel'),'cancelled').catch(()=>{});this.applying=false;this.updates.applying=false;this.updates.store.setting('update-auto-install',null);}
  async apply({target,guiPid}){
    if(this.applying)throw new Error('更新正在安装。');
    this.applying=true;this.updates.applying=true;let root,child;
    try{
    if(!Number.isInteger(guiPid)||guiPid<=0||!alive(guiPid)||![...this.runtime.clients.values()].some(client=>client.pid===guiPid))throw new Error('桌面连接已变化。');
    const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
    const expected=process.platform==='darwin'?path.resolve(this.appRoot,'../../..'):path.resolve(this.projectRoot);
    if(!target||!['darwin','win32'].includes(process.platform))throw new Error('请在正式安装的桌面软件中更新。');
    if((await fs.lstat(target)).isSymbolicLink())throw new Error('安装位置不能是符号链接。');
    // Foundation represents /private/tmp as /tmp even after resolving URLs.
    // Compare filesystem identities and stage beside the canonical directory.
    const actualTarget=await fs.realpath(target);
    if(!samePath(actualTarget,await fs.realpath(expected)))throw new Error('请在正式安装的桌面软件中更新。');
    target=actualTarget;
    const file=await this.updates.installPath();
      if(this.activity().updateBusy)throw new Error('已有任务开始，请等待任务结束后更新。');
      const ticket=randomUUID();root=path.join(this.updates.root,'apply-'+ticket);this.applicationRoot=root;await fs.mkdir(root,{mode:0o700});
      const node=path.join(root,process.platform==='win32'?'node.exe':'node');
      await fs.copyFile(process.execPath,node);await fs.chmod(node,0o700);
      await fs.copyFile(fileURLToPath(new URL('./update-helper.js',import.meta.url)),path.join(root,'helper.mjs'));
      const packageFile=path.join(root,path.basename(file));await fs.copyFile(file,packageFile);
      await fs.writeFile(path.join(root,'request.json'),JSON.stringify({schema:1,platform:process.platform,package:packageFile,target,guiPid,backendPid:process.pid,sha256:this.updates.ready.sha256,version:this.updates.candidate.version,revision:this.updates.candidate.revision}),{mode:0o600});
      this.updates.store.setting('update-application',{ticket});
      child=spawn(node,[path.join(root,'helper.mjs'),path.join(root,'request.json')],{detached:true,stdio:'ignore',windowsHide:true});
      const launch=new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});await launch;child.unref();
      const deadline=Date.now()+90000;
      for(;;){
        let result;try{result=JSON.parse(await fs.readFile(path.join(root,'status.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(result?.status==='error')throw new Error(result.error);
        if(result?.status==='ready')break;
        if(Date.now()>deadline||!alive(child.pid))throw new Error('更新准备失败，当前软件和数据保持原样。');await delay(200);
      }
      if(this.activity().updateBusy)throw new Error('已有任务开始，本次更新已取消。');
      const decision=await this.quit();if(!decision.quitAccepted)throw new Error('当前有录制任务，请结束后更新。');
      this.updates.store.setting('update-auto-install',null);
      return decision;
    }catch(error){if(root)await fs.writeFile(path.join(root,'cancel'),'cancelled').catch(()=>{});this.applying=false;this.updates.applying=false;this.updates.store.setting('update-auto-install',null);throw error;}
  }
}
