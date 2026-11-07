import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const COOKIE_PLATFORMS=['bilibili','douyin','xiaohongshu'];
const MAX_COOKIE=32768,appRoot=fileURLToPath(new URL('..',import.meta.url));
const healthKey=platform=>'platform-cookie-health:'+platform;
// The sealed bytes are randomized by the OS protector. Their digest identifies
// this saved generation across restarts without deriving a key from the secret.
const generationOf=sealed=>createHash('sha256').update(sealed).digest('hex');
const failure=()=>new Error('系统安全存储不可用，Cookie 未保存。请解锁系统钥匙串或检查应用组件后重试。');
export function normalizePlatformCookie(platform,input){
  if(!COOKIE_PLATFORMS.includes(platform)||typeof input!=='string'||input.length>MAX_COOKIE||/[\r\n\x00-\x1f\x7f]/.test(input))throw new Error('请粘贴该平台请求头中完整的 Cookie 值，勿粘贴命令、JSON 或多行文本。');
  const text=input.trim().replace(/^cookie:\s*/i,''),parts=new Map();
  for(const raw of text.split(';')){
    const item=raw.trim();if(!item)continue;
    const match=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([\x21-\x7e]*)$/.exec(item);
    if(!match||/["\\,;]/.test(match[2])||parts.has(match[1])||parts.size>=128)throw new Error('Cookie 格式无效或包含重复字段，请重新复制请求头中的值。');
    parts.set(match[1],match[2]);
  }
  if(platform==='bilibili'&&(!parts.get('SESSDATA')||!/^\d{1,20}$/.test(parts.get('DedeUserID')||'')))throw new Error('B 站 Cookie 需要包含 SESSDATA 和 DedeUserID。');
  if(platform==='douyin'&&!parts.get('sessionid')&&!parts.get('sessionid_ss'))throw new Error('抖音 Cookie 需要包含 sessionid 或 sessionid_ss，请先登录再复制。');
  if(platform==='xiaohongshu'&&(!parts.get('a1')||!parts.get('web_session')))throw new Error('小红书 Cookie 需要包含 a1 和 web_session，请先登录再复制。');
  return [...parts].map(([key,value])=>`${key}=${value}`).join('; ');
}

// Secrets travel through bounded pipes, never argv, environment variables,
// shell interpolation, ordinary settings, or a plaintext temporary file.
export class NativeCookieProtection {
  constructor({platform=process.platform,helper,launch=spawn,timeoutMs=15000}={}){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid native protection deadline.');
    this.platform=platform;this.launch=launch;this.timeoutMs=timeoutMs;
    const bundled=path.basename(path.dirname(appRoot))==='Resources';
    this.helper=helper||path.join(path.dirname(appRoot),bundled?'runtime':'.tools/runtime','credentials','cookie-protection');
    this.label=platform==='darwin'?'macOS 钥匙串 + AES-GCM':platform==='win32'?'Windows 当前用户 DPAPI':'此系统暂不支持安全保存';
  }
  async available(){
    if(this.platform==='win32')return true;
    if(this.platform!=='darwin')return false;
    try{await fs.access(this.helper,fs.constants.X_OK);return true;}catch{return false;}
  }
  async run(operation,namespace,platform,data){
    if(!await this.available())throw failure();
    const windows=this.platform==='win32';
    const executable=windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):this.helper;
    const args=windows?['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./cookie-protection.ps1',import.meta.url))]:[];
    const input=JSON.stringify({operation,namespace,context:`caibao.cookies.v1:${namespace}:${platform}`,data:Buffer.from(data).toString('base64')});
    return new Promise((resolve,reject)=>{
      let child,output=[],size=0,settled=false;
      const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(failure()):resolve(result);};
      const timer=setTimeout(()=>{child?.kill();done(true);},operation==='unlock'?120000:this.timeoutMs);
      try{child=this.launch(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{done(true);return;}
      child.on('error',()=>done(true));child.stdin.on('error',()=>done(true));child.stderr.resume();
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>192*1024){child.kill();done(true);}else output.push(chunk);});
      child.on('close',code=>{
        if(code!==0){done(true);return;}
        try{const result=JSON.parse(Buffer.concat(output).toString('utf8'));if(typeof result.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))throw 0;done(false,Buffer.from(result.data,'base64'));}catch{done(true);}
      });
      child.stdin.end(input);
    });
  }
}

export class PlatformCredentials {
  constructor(root,{protection=new NativeCookieProtection(),diagnostics,store}={}){
    // Persistent scope uses the existing user-data root, never a release
    // version or helper hash. Updates must reuse that root and this format.
    this.directory=path.join(root,'private-credentials');this.namespace=createHash('sha256').update(path.resolve(root)).digest('hex');
    this.protection=protection;this.diagnostics=diagnostics;this.store=store;this.values=new Map();this.states=new Map();this.pending=Promise.resolve();this.available=false;
  }
  file(platform){if(!COOKIE_PLATFORMS.includes(platform))throw new Error('不支持的平台。');return path.join(this.directory,platform+'.sealed');}
  snapshot(){return {available:this.available,storage:this.protection.label,platforms:Object.fromEntries(COOKIE_PLATFORMS.map(p=>[p,{configured:this.states.get(p)?.configured===true,loaded:this.values.has(p),expired:this.isExpired(p),error:this.states.get(p)?.error||''}]))};}
  isExpired(platform){return this.states.get(platform)?.expired===true;}
  generation(platform){return this.states.get(platform)?.generation;}
  get(platform){return this.isExpired(platform)?'':this.values.get(platform)||'';}
  warnings(){
    return COOKIE_PLATFORMS.flatMap(platform=>{
      const state=this.states.get(platform);
      return state?.expired&&!state.acknowledged?[{platform,generation:state.generation}]:[];
    });
  }
  expire(platform,generation){
    const state=this.states.get(platform);
    if(!this.get(platform)||state.generation!==generation)return false;
    state.expired=true;
    try{this.store?.setting(healthKey(platform),{generation,acknowledged:false});}
    catch{this.diagnostics?.record('Cookie 状态','未能保存失效状态，本次运行仍使用匿名连接。',{level:'警告'});}
    return true;
  }
  acknowledge(platform,generation){
    const state=this.states.get(platform);
    if(!state?.expired||state.generation!==generation||state.acknowledged)return;
    this.store?.setting(healthKey(platform),{generation,acknowledged:true});
    state.acknowledged=true;
  }
  setLoaded(platform,value,sealed,restoring=false){
    const generation=generationOf(sealed);
    const previous=this.states.get(platform);
    let saved;
    if(restoring){
      try{saved=this.store?.setting(healthKey(platform));}
      catch{this.diagnostics?.record('Cookie 状态','暂时无法读取已保存的失效状态。',{level:'警告'});}
      if(previous?.generation===generation&&previous.expired)saved={generation,acknowledged:previous.acknowledged};
    }
    const expired=saved?.generation===generation;
    this.values.set(platform,value);
    this.states.set(platform,{configured:true,generation,expired,acknowledged:expired&&saved.acknowledged===true});
  }
  protect(value){this.diagnostics?.protectSecret(value);for(const raw of value.split(';')){const part=raw.trim();this.diagnostics?.protectSecret(part.slice(part.indexOf('=')+1));}}
  async restore(platform,operation='open'){
    const directory=await fs.lstat(this.directory),file=this.file(platform);
    if(!directory.isDirectory()||directory.isSymbolicLink())throw failure();
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>96*1024)throw failure();
    const sealed=await fs.readFile(file);
    const plain=await this.protection.run(operation,this.namespace,platform,sealed);let value;
    try{value=normalizePlatformCookie(platform,plain.toString('utf8'));}finally{plain.fill(0);}
    this.protect(value);this.setLoaded(platform,value,sealed,true);
  }
  async initialize(){
    this.available=await this.protection.available();
    try{const directory=await fs.lstat(this.directory);if(!directory.isDirectory()||directory.isSymbolicLink())throw failure();}
    catch(error){if(error.code!=='ENOENT'){for(const platform of COOKIE_PLATFORMS)this.states.set(platform,{configured:true,error:'安全保存目录异常，请检查本机数据目录。'});return this;}}
    for(const platform of COOKIE_PLATFORMS){
      try{await this.restore(platform);}
      catch(error){if(error.code!=='ENOENT')this.states.set(platform,{configured:true,error:'安全保存项无法读取或未能解锁，暂以未登录方式工作。可点击“解锁已保存的 Cookie”完成系统授权，无需重新填写。'});}
    }
    return this;
  }
  serial(work){const operation=this.pending.catch(()=>{}).then(work);this.pending=operation;return operation;}
  unlock(platform){return this.serial(async()=>{
    try{await this.restore(platform,'unlock');}catch{throw new Error('未能解锁已保存的 Cookie，请完成系统授权后重试。原内容已保留。');}
    return this.snapshot();
  });}
  save(platform,input){return this.serial(async()=>{
    const value=normalizePlatformCookie(platform,input);this.protect(value);
    const plain=Buffer.from(value);let sealed;try{sealed=await this.protection.run('seal',this.namespace,platform,plain);}finally{plain.fill(0);}
    if(!Buffer.isBuffer(sealed)||sealed.length<28||sealed.length>96*1024)throw failure();
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});const directory=await fs.lstat(this.directory);if(directory.isSymbolicLink()||!directory.isDirectory())throw failure();
    await fs.chmod(this.directory,0o700);const file=this.file(platform),temporary=path.join(this.directory,randomUUID()+'.tmp');
    try{const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(sealed);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);}
    catch{await fs.rm(temporary,{force:true}).catch(()=>{});throw failure();}
    this.setLoaded(platform,value,sealed);this.available=true;return this.snapshot();
  });}
  remove(platform){return this.serial(async()=>{
    try{const directory=await fs.lstat(this.directory);if(!directory.isDirectory()||directory.isSymbolicLink())throw failure();}catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.rm(this.file(platform),{force:true});this.values.delete(platform);this.states.delete(platform);return this.snapshot();
  });}
  async close(){await this.pending.catch(()=>{});this.values.clear();}
}
