// Keep decoding preroll separate from comment lifetime. ASS events already
// carry their global clock and layout; only video reorder needs preroll here.
export function videoReadStart(source,from,info){
  const known=Number.isInteger(info?.bFrames)&&info.bFrames>=0&&info.bFrames<=16&&info.fps>=1&&info.fps<=240;
  return Math.max(source.start,from-(known?Math.max(.1,(info.bFrames+2)/info.fps):6));
}

export function sequenceEligible(plan,parts){
  if(plan.live||!plan.profile?.encoder||parts.length<2||parts.length>2)return false;
  return parts.every((p,i)=>!p.cached&&!p.reuse&&p.source.closed===2&&p.to-p.from>=10&&
    p.source.id===parts[0].source.id&&(!i||Math.abs(p.from-parts[i-1].to)<.00001))&&parts.at(-1).to-parts[0].from<=120.001;
}

// Register all cache producers before launching their shared decoder. A failed
// reservation or cancellation rejects the rendezvous and drains the real child.
export function renderRendezvous(count,run){
  const slots=new Map(),controller=new AbortController();let work,stopped;
  const stop=error=>{stopped??=error;controller.abort();for(const slot of slots.values())slot.reject(stopped);};
  const start=()=>{
    if(slots.size!==count||work||stopped)return;
    work=Promise.resolve().then(()=>run([...Array(count)].map((_,i)=>slots.get(i).file),controller.signal));
    work.then(()=>{for(const slot of slots.values())slot.resolve();},stop);
  };
  return {
    stop,
    skip(index){if(!slots.has(index)){slots.set(index,{file:null,resolve(){},reject(){}});start();}},
    async render(index,file,{signal}={}){
      if(stopped)throw stopped;
      const abort=()=>stop(Object.assign(new Error('连续分块处理已取消。'),{name:'AbortError',code:'PREP_CANCELLED'}));
      signal?.addEventListener('abort',abort,{once:true});
      try{
        await new Promise((resolve,reject)=>{
          slots.set(index,{file,resolve,reject});
          if(signal?.aborted){abort();return;}
          start();
        });
      }finally{signal?.removeEventListener('abort',abort);if(work)await work.catch(()=>{});}
    },
    async settle(){if(work)await work.catch(()=>{});}
  };
}
