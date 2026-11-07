import {platformLabel} from '../shared/platforms.js';
import { COOKIE_PLATFORMS } from './platform-credentials.js';

// Account verification is independent of room polling, chat and media writes.
const CHECK_INTERVAL_MS=120000;
const CHECK_TIMEOUT_MS=8000;

export class PlatformCookieValidation {
  constructor(credentials,platforms,{diagnostics,now=Date.now}={}){
    Object.assign(this,{credentials,platforms,diagnostics,now});
    this.attempts=new Map();
    this.shutdown=new AbortController();
  }
  status(platform){
    if(this.credentials.isExpired(platform))return 'invalid';
    const attempt=this.attempts.get(platform);
    return attempt?.generation===this.credentials.generation(platform)?attempt?.result||'unknown':'unknown';
  }
  tick(){
    return Promise.all(COOKIE_PLATFORMS.map(platform=>this.check(platform)));
  }
  check(platform,{force=false}={}){
    const cookie=this.credentials.get(platform),generation=this.credentials.generation(platform);
    if(!cookie||this.shutdown.signal.aborted)return;
    const previous=this.attempts.get(platform);
    if(previous?.generation===generation){
      if(previous.pending)return previous.pending;
      if(!force&&this.now()<previous.nextAt)return;
    }
    const attempt={generation,result:previous?.generation===generation?previous.result:'unknown',nextAt:0,pending:null};
    this.attempts.set(platform,attempt);
    attempt.pending=this.verify(platform,cookie,attempt).finally(()=>{
      attempt.pending=null;
      attempt.nextAt=this.now()+CHECK_INTERVAL_MS;
    });
    return attempt.pending;
  }
  async verify(platform,cookie,attempt){
    const adapter=this.platforms.get(platform);
    const signal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    let valid;
    try{valid=await adapter.verifyCookie({cookie,signal});}
    catch{ /* Network, rate limits and unrecognized responses are inconclusive. */ }
    if(this.shutdown.signal.aborted||this.credentials.generation(platform)!==attempt.generation)return;
    if(signal.aborted||typeof valid!=='boolean'){
      attempt.result='unavailable';
      return;
    }
    if(valid){
      attempt.result='valid';
      return;
    }
    if(!this.credentials.expire(platform,attempt.generation))return;
    attempt.result='invalid';
    const name=platformLabel(platform);
    this.diagnostics?.record(name+' Cookie','平台已确认登录失效，后续采集使用匿名连接。',{level:'警告',important:true});
    await adapter.applySavedCredentials();
  }
  close(){this.shutdown.abort();}
}
