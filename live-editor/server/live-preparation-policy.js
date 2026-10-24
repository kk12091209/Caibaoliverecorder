import { liveSystemResources } from './live-system-resources.js';

const GiB=1024**3;

export class LivePreparationPolicy {
  constructor({now=Date.now,resources=liveSystemResources({now}),windowMs=60000,budgetMs=18000,
    healthyMs=30000,sampleMaxAgeMs=30000,tailSeconds=90}={}) {
    if(!(windowMs>0&&budgetMs>0&&budgetMs<=windowMs&&healthyMs>=0&&sampleMaxAgeMs>0))throw new Error('Invalid live preparation budget');
    Object.assign(this,{now,resources,windowMs,budgetMs,healthyMs,sampleMaxAgeMs,tailSeconds});
    this.sessions=new Map();this.history=[];this.active=null;this.grant=null;this.nextStartAt=0;this.lastNow=-Infinity;this.evaluation=0;
  }
  state(identity) {
    let state=this.sessions.get(identity);
    if(!state){state={healthySince:null,failures:0,cooldownUntil:0,fault:null,disabled:false};this.sessions.set(identity,state);}
    while(this.sessions.size>16)this.sessions.delete(this.sessions.keys().next().value);
    return state;
  }
  used(at=this.now()) {
    this.history=this.history.filter(interval=>interval.end>at-this.windowMs);
    return this.history.reduce((sum,interval)=>sum+Math.max(0,Math.min(at,interval.end)-Math.max(at-this.windowMs,interval.start)),0)+
      (this.active?Math.max(0,at-Math.max(at-this.windowMs,this.active.startedAt)):0);
  }
  fault(state,reason,at) {
    state.healthySince=null;
    if(state.fault)return;
    state.fault=reason;state.failures++;state.cooldownUntil=at+[60000,120000,300000][Math.min(2,state.failures-1)];
    if(state.failures>=3)state.disabled=true;
  }
  async evaluate(context={}) {
    const revision=++this.evaluation,at=this.now(),identity=String(context.recordingIdentity||context.sessionId||'');
    this.grant=null;
    const result=(reason,{allowed=false,urgent=false,retryAfterMs=null}={})=>({allowed,reason,urgent,retryAfterMs,
      tailSeconds:this.tailSeconds,budgetMs:this.budgetMs,usedMs:this.used(this.now())});
    if(at<this.lastNow){this.lastNow=at;this.nextStartAt=at+this.windowMs;for(const state of this.sessions.values())state.healthySince=null;return result('clock-changed',{urgent:!!this.active,retryAfterMs:this.windowMs});}
    this.lastNow=at;
    if(!identity||context.recordingCount!==1)return result('single-recording-required',{urgent:!!this.active});
    const state=this.state(identity);
    if(this.active&&this.active.identity!==identity)return result('recording-changed',{urgent:true});
    const unsafe=(reason)=>{this.fault(state,reason,this.now());return result(state.disabled?'disabled-for-recording':reason,{urgent:true,retryAfterMs:state.disabled?null:Math.max(0,state.cooldownUntil-this.now())});};
    if(context.recordingState==='observing'||context.recordingHealthy===undefined){state.healthySince=null;return result('recording-observation',{urgent:!!this.active,retryAfterMs:1000});}
    if(context.recordingHealthy!==true)return unsafe('recording-unhealthy');
    if(context.recordingWriteHealthy===false)return unsafe('recording-write-pressure');
    if(Number.isFinite(context.ingestLagMs)&&context.ingestLagMs>15000)return unsafe('ingest-behind');
    if(Number.isFinite(context.loopDelayMs)&&context.loopDelayMs>250)return unsafe('event-loop-pressure');
    if(context.hardwareAvailable!==true){state.healthySince=null;return result('hardware-unavailable',{urgent:!!this.active});}
    let resource;
    try{resource=await this.resources();}catch{state.healthySince=null;return result('resources-unavailable',{urgent:!!this.active});}
    if(revision!==this.evaluation)return result('superseded',{retryAfterMs:1000});
    const checked=this.now();
    if(!resource?.supported||!Number.isFinite(resource.sampledAt)||resource.sampledAt>checked+1000||checked-resource.sampledAt>this.sampleMaxAgeMs){
      state.healthySince=null;return result(resource?.reason||'resources-stale',{urgent:!!this.active});
    }
    if(resource.acPower!==true||resource.lowPowerMode!==false){state.healthySince=null;return result('power-saving',{urgent:!!this.active});}
    if(!['nominal','fair','serious','critical'].includes(resource.thermal)){state.healthySince=null;return result('thermal-unavailable',{urgent:!!this.active});}
    if(resource.thermal==='serious'||resource.thermal==='critical')return unsafe('thermal-pressure');
    if(!Number.isFinite(resource.totalMemoryBytes)||resource.totalMemoryBytes<8*GiB){state.healthySince=null;return result('small-device',{urgent:!!this.active});}
    if(!Number.isFinite(resource.availableMemoryBytes)) {state.healthySince=null;return result('memory-unavailable',{urgent:!!this.active});}
    if(resource.availableMemoryBytes<Math.max(2*GiB,resource.totalMemoryBytes*.15))return unsafe('memory-pressure');
    // Fair thermal state and busy CPU are ordinary pauses. Starting more work
    // would increase heat/load, but this is not a recording fault or a retry.
    if(resource.thermal!=='nominal'||(Number.isFinite(resource.cpuUsage)&&resource.cpuUsage>.70)){
      state.healthySince=null;return result(resource.thermal!=='nominal'?'thermal-warm':'cpu-busy',{retryAfterMs:10000});
    }
    state.fault=null;
    if(state.disabled)return result('disabled-for-recording',{urgent:!!this.active});
    if(checked<state.cooldownUntil){state.healthySince=null;return result('recovery-cooldown',{retryAfterMs:state.cooldownUntil-checked});}
    if(state.healthySince===null)state.healthySince=checked;
    if(checked-state.healthySince<this.healthyMs)return result('health-observation',{retryAfterMs:this.healthyMs-(checked-state.healthySince)});
    if(context.foreground)return result('foreground',{retryAfterMs:1000});
    if(context.sourceReady!==true)return result('source-not-ready',{retryAfterMs:1000});
    if(this.active)return result('already-processing',{retryAfterMs:1000});
    const used=this.used(checked);
    if(checked<this.nextStartAt||used>=this.budgetMs){
      const windowWait=used>=this.budgetMs?Math.max(1000,(this.history[0]?.start??checked)+this.windowMs-checked+1000):0;
      return result('work-budget',{retryAfterMs:Math.max(1000,this.nextStartAt-checked,windowWait)});
    }
    this.grant={identity,at:checked};return result('ready',{allowed:true,retryAfterMs:0});
  }
  start(identity) {
    const at=this.now();identity=String(identity);
    if(this.active||!this.grant||this.grant.identity!==identity||at<this.grant.at||at-this.grant.at>1000||at<this.nextStartAt||this.used(at)>=this.budgetMs)return null;
    const token={identity,startedAt:at};this.active=token;this.grant=null;return token;
  }
  finish(token,{outcome='success',elapsedMs}={}) {
    if(!token||token!==this.active)return false;
    const at=this.now(),duration=Math.max(0,at-token.startedAt,Number.isFinite(elapsedMs)?elapsedMs:0);
    this.active=null;this.grant=null;
    this.history.push({start:at-duration,end:at});
    // A block may exceed its allowance; charge every millisecond, including
    // cancellation, and repay the overrun through rest rather than redoing it.
    this.nextStartAt=Math.max(at,token.startedAt+duration*this.windowMs/this.budgetMs);
    if(outcome==='failure')this.fault(this.state(token.identity),'processing-failed',at);
    this.used(at);return true;
  }
}
