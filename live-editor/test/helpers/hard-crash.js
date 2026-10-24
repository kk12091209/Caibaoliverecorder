import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

// The parent kills the worker at its acknowledged crash point. Windows reports
// forced termination as an exit code, rather than a POSIX SIGKILL signal.
export async function hardCrash(script,{timeout=30000}={}) {
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='',reached=false,killed=false,timedOut=false,error;
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-16384);});
  child.on('message',message=>{
    if(message?.testEvent==='crash-now'&&!reached){reached=true;killed=child.kill('SIGKILL');}
  });
  child.on('error',value=>{error=value;});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  clearTimeout(timer);
  assert.ifError(error);
  assert.equal(timedOut,false,`worker timed out: ${stderr}`);
  assert.equal(reached,true,`worker did not reach its crash point: ${stderr}`);
  assert.equal(killed,true,`worker was not forcibly terminated: ${stderr}`);
  assert.ok(result.signal||result.code!==0,`worker exited normally: ${stderr}`);
}
