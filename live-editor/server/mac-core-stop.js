import {setTimeout as delay} from 'node:timers/promises';

// The CLI explicitly handles Ctrl+C. Give it time to close writers before
// escalating, and recheck the original process identity before every signal.
export async function stopMacCore(pid,{inspect,isAlive,signal,wait=delay,now=Date.now,
  report=event=>console.warn('[recorder-core-stop]',JSON.stringify(event)),
  stages=[['SIGINT',8000],['SIGTERM',5000],['SIGKILL',2000]]}){
  const started=now();
  const log=(stage,outcome)=>report({pid,stage,outcome,elapsedMs:now()-started});
  if(!isAlive(pid))return true;
  const identity=await inspect(pid);
  if(!identity){log('verify','unverified');return !isAlive(pid);}
  for(const [name,timeout] of stages){
    if(!isAlive(pid))return true;
    if(await inspect(pid)!==identity){log(name,'identity-changed');return !isAlive(pid);}
    try{signal(pid,name);}catch(error){
      log(name,error.code||'signal-failed');return error.code==='ESRCH';
    }
    log(name,'sent');
    const deadline=now()+timeout;
    while(isAlive(pid)&&now()<deadline)await wait(Math.min(50,deadline-now()));
    if(!isAlive(pid)){log(name,'exited');return true;}
    log(name,'timeout');
  }
  return false;
}
