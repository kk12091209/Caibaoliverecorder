import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile),GiB=1024**3;

// macOS freemem excludes reclaimable caches. Query its own pressure estimate
// at most once per thirty seconds; an unavailable sample stays conservative.
export function idleResourceSampler({platform=process.platform,now=Date.now,query=()=>execute('/usr/bin/memory_pressure',['-Q'],{timeout:1500,maxBuffer:4096})}={}) {
  let cached,pending,checked=-Infinity;
  return async()=>{
    if(cached&&now()-checked<30000)return cached;
    if(pending)return pending;
    pending=(async()=>{
      const total=os.totalmem();let available=os.freemem(),source='free-memory';
      if(platform==='darwin')try{
        const {stdout}=await query(),match=stdout.match(/System-wide memory free percentage:\s*(\d+)%/);
        if(match&&Number(match[1])<=100){available=total*Number(match[1])/100;source='memory-pressure';}
      }catch{ /* Fall back to the conservative OS free-memory value. */ }
      cached={cores:os.availableParallelism(),total,available,source};checked=now();return cached;
    })().finally(()=>{pending=null;});
    return pending;
  };
}

export class IdleRenderPolicy {
  constructor({mode='adaptive',threads,resources=idleResourceSampler()}={}) {
    if(!['adaptive','single','parallel','legacy'].includes(mode))throw new Error('未知的闲时处理策略。');
    if(threads!==undefined&&(!Number.isInteger(threads)||threads<2||threads>6))throw new Error('闲时处理线程数应为 2 至 6。');
    this.mode=mode;this.resources=resources;
    this.threads=mode==='single'?Math.max(2,Math.min(6,Math.floor(threads||Math.min(4,os.availableParallelism()/2)))):2;
    this.sessions=new Map();this.last=null;
  }
  reset(id){this.sessions.delete(id);}
  state(id,signature){
    let state=this.sessions.get(id);
    if(!state||state.signature!==signature){state={signature,singles:[],decision:'sampling',baselineMsPerSecond:0,parallelMsPerSecond:0};this.sessions.set(id,state);}
    while(this.sessions.size>8)this.sessions.delete(this.sessions.keys().next().value);
    return state;
  }
  async choose(id,signature,plan,blocks,cache) {
    const state=this.state(id,signature),decision={mode:this.mode,decision:state.decision,concurrency:1,threads:this.threads,reason:'serial'};
    const finish=reason=>(this.last={...decision,reason});
    if(['single','legacy'].includes(this.mode))return finish(this.mode);
    if(blocks.length<2)return finish('last-block');
    // The regular 60-second blocks are comparable; tiny tails are not useful
    // calibration samples and do not justify another concurrent decoder.
    if(blocks.slice(0,2).some(block=>(block.endMs-block.startMs)<10000))return finish('short-block');
    let resource;try{resource=await this.resources();}catch{return finish('resources-unavailable');}
    const frameBytes=(plan.profile?.width||1920)*(plan.profile?.height||1080)*4;
    const workerBytes=Math.max(256*1024**2,frameBytes*48);
    if(resource.cores<6||resource.total<8*GiB)return finish('small-device');
    if(!Number.isFinite(resource.available)||resource.available<2*GiB+workerBytes*2)return finish('memory-pressure');
    const expected=blocks.slice(0,2).reduce((sum,block)=>sum+Math.ceil((block.endMs-block.startMs)/1000*2*1024**2),0);
    if(cache?.entries&&Number.isFinite(cache.maxBytes)) {
      const used=[...cache.entries.values()].reduce((sum,entry)=>sum+entry.bytes,0);
      if(cache.maxBytes-used-(cache.reserved||0)<expected)return finish('cache-budget');
    }
    try{if(cache?.freeSpace)await cache.freeSpace(expected+(cache.reserved||0));}catch{return finish('disk-pressure');}
    if(state.decision==='serial')return finish('no-parallel-gain');
    if(this.mode==='adaptive'&&state.singles.length<2)return finish('measure-single');
    decision.concurrency=2;return finish(this.mode==='parallel'?'parallel-requested':state.decision==='parallel'?'measured-parallel':'measure-parallel');
  }
  observe(id,signature,decision,seconds,elapsedMs,{complete=true}={}) {
    const state=this.state(id,signature);
    if(!complete||seconds<=0||elapsedMs<=0)return;
    if(this.mode!=='adaptive')return;
    const rate=elapsedMs/seconds;
    if(decision.concurrency===1&&decision.reason==='measure-single'&&state.singles.length<2){state.singles.push(rate);state.baselineMsPerSecond=state.singles.reduce((a,b)=>a+b,0)/state.singles.length;}
    if(decision.concurrency===2){
      state.parallelMsPerSecond=rate;
      // Recheck continuing batches too: a sustained resource/content change
      // must not leave the machine stuck in a slower parallel mode.
      state.slowBatches=rate>state.baselineMsPerSecond*.9?(state.slowBatches||0)+1:0;
      if(state.decision==='sampling'||state.slowBatches>=2)state.decision=rate<=state.baselineMsPerSecond*.9?'parallel':'serial';
    }
    this.last={...decision,decision:state.decision,baselineMsPerSecond:state.baselineMsPerSecond,parallelMsPerSecond:state.parallelMsPerSecond};
  }
}
