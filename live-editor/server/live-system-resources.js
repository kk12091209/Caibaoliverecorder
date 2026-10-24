import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile),appRoot=fileURLToPath(new URL('..',import.meta.url));

export function liveResourceHelperPath({env=process.env,root=appRoot}={}) {
  if(env.CAIBO_LIVE_RESOURCE_HELPER)return path.resolve(env.CAIBO_LIVE_RESOURCE_HELPER);
  // The installed app keeps runtimes beside live-editor; development keeps
  // them in the repository's ignored .tools directory. Never compile at run time.
  const bundled=path.basename(path.dirname(root))==='Resources';
  return path.join(path.dirname(root),bundled?'runtime':'.tools/runtime','resources','live-system-resources');
}

function cpuTotals(cpus) {
  let total=0,idle=0;
  for(const cpu of cpus){idle+=cpu.times.idle;total+=Object.values(cpu.times).reduce((sum,value)=>sum+value,0);}
  return {total,idle};
}

// Both commands are fixed, local, read-only, time-bounded and coalesced. A failed
// refresh replaces an old healthy result: stale safety signals cannot enable work.
export function liveSystemResources({platform=process.platform,now=Date.now,intervalMs=10000,
  helper=liveResourceHelperPath(),query=(file,args)=>execute(file,args,{timeout:1500,maxBuffer:4096,windowsHide:true}),
  totalMemory=()=>os.totalmem(),cpus=()=>os.cpus()}={}) {
  let cached,pending,checked=-Infinity,previousCpu;
  return async()=>{
    const current=now();
    if(cached&&current>=checked&&current-checked<intervalMs)return cached;
    if(pending)return pending;
    pending=(async()=>{
      if(platform!=='darwin')return cached={supported:false,reason:'platform-unavailable',sampledAt:now()};
      try {
        const [native,memory]=await Promise.all([query(helper,[]),query('/usr/bin/memory_pressure',['-Q'])]);
        const sample=JSON.parse(native.stdout),at=now();
        const percent=memory.stdout.match(/System-wide memory free percentage:\s*(\d+)%/);
        if(sample.version!==1||!Number.isFinite(sample.sampledAt)||sample.sampledAt>at+1000||at-sample.sampledAt>5000||
          typeof sample.acPower!=='boolean'||typeof sample.lowPowerMode!=='boolean'||
          !['nominal','fair','serious','critical'].includes(sample.thermal)||!percent||Number(percent[1])>100)
          throw new Error('Untrusted resource sample');
        const total=totalMemory(),cpu=cpuTotals(cpus()),elapsed=previousCpu?cpu.total-previousCpu.total:0;
        const usage=elapsed>0?1-(cpu.idle-previousCpu.idle)/elapsed:null;previousCpu=cpu;
        return cached={supported:true,source:'macos-native',sampledAt:at,acPower:sample.acPower,
          lowPowerMode:sample.lowPowerMode,thermal:sample.thermal,totalMemoryBytes:total,
          availableMemoryBytes:total*Number(percent[1])/100,cpuUsage:usage===null?null:Math.max(0,Math.min(1,usage))};
      } catch { return cached={supported:false,reason:'resources-unavailable',sampledAt:now()}; }
    })().finally(()=>{checked=now();pending=null;});
    return pending;
  };
}
