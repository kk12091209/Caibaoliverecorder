const cancelled = () => Object.assign(new Error('预览请求已被取消或替换。'), {name:'AbortError',code:'PREVIEW_CANCELLED',status:409});
export function validatePreviewRequest(client, sequence) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(client || '') || !Number.isSafeInteger(sequence) || sequence < 1)
    throw Object.assign(new Error('预览请求标识无效。'), {status:400});
}

// Each page owns one running producer and at most one pending destination.
// Cancelled producers remain protected until their child and pipes settle.
export class PreviewRequests {
  constructor({releaseTimeoutMs=10000, retentionMs=300000, maxClients=128, now=Date.now}={}) {
    Object.assign(this,{releaseTimeoutMs,retentionMs,maxClients,now});this.clients=new Map();this.closed=false;
  }
  state(client) {
    for(const [key,value] of this.clients)if(!value.active&&!value.pending&&this.now()-value.used>this.retentionMs)this.clients.delete(key);
    let state=this.clients.get(client);
    if(!state){
      if(this.clients.size>=this.maxClients)throw new Error('预览请求过多，请稍后再试。');
      state={sequence:0,stoppedThrough:0,active:null,pending:null,used:this.now()};this.clients.set(client,state);
    }
    state.used=this.now();return state;
  }
  run(client,sequence,sessionId,signal,work) {
    validatePreviewRequest(client,sequence);
    if(this.closed)return Promise.reject(cancelled());
    const state=this.state(client);
    // A late GET cannot resurrect a destination cancelled before it arrived.
    if(sequence<state.sequence||sequence<=state.stoppedThrough||signal?.aborted)return Promise.reject(cancelled());
    state.sequence=sequence;
    state.pending?.controller.abort();state.active?.controller.abort();
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    let resolve,reject;
    const request={sequence,sessionId,controller,signal:combined,done:new Promise((yes,no)=>{resolve=yes;reject=no;})};
    const previous=state.active?.done;
    state.pending=request;
    this.execute(state,request,previous,work).then(resolve,reject);
    return request.done;
  }
  async execute(state,request,previous,work) {
    try{
      if(previous)await this.waitForRelease(previous,request.signal);
      if(this.closed||request.signal.aborted||state.pending!==request)throw cancelled();
      state.pending=null;state.active=request;
      return await work(request.signal);
    }finally{
      if(state.pending===request)state.pending=null;
      if(state.active===request)state.active=null;
      state.used=this.now();
    }
  }
  waitForRelease(previous,signal) {
    return new Promise((resolve,reject)=>{
      let timer;
      const finish=error=>{clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>finish(cancelled());
      signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(Object.assign(new Error('旧预览释放超时，请稍后重新定位。'),{code:'PREVIEW_RELEASE_TIMEOUT',status:503})),this.releaseTimeoutMs);
      previous.then(()=>finish(),()=>finish());
      if(signal.aborted)abort();
    });
  }
  stop(client,sequence) {
    validatePreviewRequest(client,sequence);
    const state=this.state(client);state.sequence=Math.max(state.sequence,sequence);state.stoppedThrough=Math.max(state.stoppedThrough,sequence);
    for(const request of [state.pending,state.active])if(request&&request.sequence<=sequence)request.controller.abort();
  }
  cancelSession(sessionId) {
    const requests=[];
    for(const state of this.clients.values())for(const request of [state.pending,state.active])if(request?.sessionId===sessionId){
      state.stoppedThrough=Math.max(state.stoppedThrough,request.sequence);request.controller.abort();requests.push(request.done);
    }
    return Promise.allSettled(requests);
  }
  close() {this.closed=true;for(const state of this.clients.values())for(const request of [state.pending,state.active])request?.controller.abort();}
}
