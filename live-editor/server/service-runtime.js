import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SERVICE_PROTOCOL=1;
export const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
export async function serviceBuild(appRoot){
  const hash=createHash('sha256'),names=['package.json',...(await fs.readdir(path.join(appRoot,'server'))).filter(name=>name.endsWith('.js')).sort().map(name=>'server/'+name)];
  for(const name of names)hash.update(name+'\n').update(await fs.readFile(path.join(appRoot,name))).update('\0');
  return hash.digest('hex');
}
export async function atomicJson(file,value){
  const temporary=file+'.'+randomBytes(8).toString('hex')+'.next';
  try{await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};

// A separate SQLite exclusive transaction supplies an OS-backed lease. Its
// locks disappear on process death; no stale PID file can be stolen in a race.
// Acquire before opening Store, whose constructor performs recovery writes.
export class ServiceRuntime {
  static async acquire(root,appRoot,{managed=false,now=Date.now,isAlive=alive,startupGraceMs=30000,clientTimeoutMs=10000}={}){
    await fs.mkdir(root,{recursive:true});root=await fs.realpath(root);
    const runtime=new ServiceRuntime(root,{managed,now,isAlive,startupGraceMs,clientTimeoutMs});
    runtime.build=await serviceBuild(appRoot);
    try{
      runtime.lease=new DatabaseSync(runtime.lockFile);
      runtime.lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease(owner TEXT); BEGIN EXCLUSIVE; DELETE FROM lease;');
      runtime.lease.prepare('INSERT INTO lease(owner) VALUES(?)').run(JSON.stringify({pid:process.pid,instance:runtime.instance}));
      return runtime;
    }catch(error){
      runtime.lease?.close();runtime.lease=null;
      if([5,6].includes(error.errcode)||/database (?:is )?locked|database is busy/i.test(error.message))throw Object.assign(new Error('这份素材数据已有后台服务，正在连接已有服务。'),{code:'SERVICE_RUNNING'});
      throw error;
    }
  }
  constructor(root,{managed,now,isAlive,startupGraceMs,clientTimeoutMs}){
    Object.assign(this,{root,managed,now,isAlive,startupGraceMs,clientTimeoutMs});
    this.started=now();this.instance=randomBytes(16).toString('hex');this.token=randomBytes(32).toString('hex');
    this.file=path.join(root,'desktop-service.json');this.lockFile=path.join(root,'desktop-service.lock.sqlite');
    this.clients=new Map();this.pending='';this.closed=false;this.stopping=false;
  }
  async publish(port){
    this.origin='http://127.0.0.1:'+port;
    await atomicJson(this.file,{protocol:SERVICE_PROTOCOL,instance:this.instance,token:this.token,pid:process.pid,origin:this.origin,dataPath:this.root,build:this.build});
    // Recovery may take time on a slow disk. Give the desktop its full grace
    // period only after the backend can actually accept a heartbeat.
    this.started=this.now();
  }
  authorized(req){return req.headers['x-caibo-instance']===this.token;}
  heartbeat(client,pid){
    if(typeof client!=='string'||!/^[a-f0-9-]{16,64}$/i.test(client)||!Number.isInteger(pid)||pid<=0)throw new Error('无效的桌面连接。');
    this.clients.set(client,{pid,seen:this.now()});
  }
  liveClients(){
    for(const [key,value] of this.clients)if(this.now()-value.seen>this.clientTimeoutMs||!this.isAlive(value.pid))this.clients.delete(key);
    return this.clients.size;
  }
  request(mode){if(!['exit','restart','quit'].includes(mode))throw new Error('无效的后台操作。');if(this.pending!=='quit')this.pending=mode;}
  shouldStop(activity){
    if(this.closed||this.stopping||activity.busy)return false;
    if(this.pending)return true;
    return this.managed&&this.now()-this.started>=this.startupGraceMs&&this.liveClients()===0;
  }
  status(activity){return {protocol:SERVICE_PROTOCOL,instance:this.instance,build:this.build,dataPath:this.root,pid:process.pid,pending:this.pending,stopping:this.stopping,quitError:this.quitError||'',...activity};}
  async release(){
    if(this.closed)return;this.closed=true;
    try{
      const owner=await readJson(this.file);
      if(owner?.instance===this.instance)await fs.unlink(this.file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }finally{
      try{this.lease?.exec('ROLLBACK;');}finally{this.lease?.close();this.lease=null;}
    }
  }
}
