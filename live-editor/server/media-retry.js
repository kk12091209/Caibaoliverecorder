import {setTimeout as pause} from 'node:timers/promises';

const temporary=new Set(['EBUSY','EAGAIN','EINTR','EMFILE','ENFILE','ETIMEDOUT','ECONNRESET']);
const terminal=new Set(['ENOSPC','EDQUOT','NO_SPACE','PREP_SPACE','EIO','EACCES','EPERM','EROFS','ENOENT','SOURCE_MISSING','SOURCE_CHANGED','PREP_STALE','PREP_INCOMPATIBLE']);
export function mediaFailure(error){
  if(error?.savePending||error?.name==='AbortError'||['EXPORT_CANCELLED','PREP_CANCELLED','ABORT_ERR'].includes(error?.code))return 'stop';
  let transient=false;
  for(let current=error,depth=0;current&&depth++<5;current=current.cause){
    if(terminal.has(current.code))return 'action';
    if(temporary.has(current.code))transient=true;
  }
  const message=String(error?.message||'');
  if(/No space left|Disk quota exceeded|Input\/output error|Permission denied|Read-only file system|No such file or directory/i.test(message))return 'action';
  return transient||/Resource temporarily unavailable|Device or resource busy|Too many open files|Connection timed out/i.test(message)?'temporary':'stop';
}

// Retry a whole safe unit so every attempt creates a fresh input iterator.
// Unknown errors, missing input, full disks and cancellation require action.
export async function retryMedia(work,{signal,retries=2,delayMs=250,report=()=>{},sleep=pause,allowRetry=()=>true}={}){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();
    try{return await work(attempt);}
    catch(error){
      if(signal?.aborted||attempt>=retries||mediaFailure(error)!=='temporary'||!allowRetry(error))throw error;
      report({attempt:attempt+1,retries,code:error.code||'TEMPORARY_IO'});
      await sleep(Math.min(2000,delayMs*2**attempt),undefined,{signal});
    }
  }
}
