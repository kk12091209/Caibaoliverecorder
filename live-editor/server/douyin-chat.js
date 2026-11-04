import {Worker} from 'node:worker_threads';
import { DEFAULT_CHAT_RATE, validateChatRate } from './chat-rules.js';
import {safeChatStatus,DouyinChatHealth} from './douyin-chat-status.js';

// Decoding, signing and sampling stay off the editor/SQLite event loop. A room
// has at most one unacknowledged batch; its quota covers pending disk writes.
export class DouyinChat {
  constructor({createWorker=()=>new Worker(new URL('./douyin-chat-worker.js',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:160,maxYoungGenerationSizeMb:16}}),timeoutMs=30000}={}) {
    this.createWorker=createWorker;this.timeoutMs=timeoutMs;this.clients=new Map();this.closed=false;this.rateLimit=DEFAULT_CHAT_RATE;
  }
  setRateLimit(value) { this.rateLimit=validateChatRate(value);this.worker?.postMessage({type:'configure',rateLimit:value}); }
  start(key,details,{write,status=()=>{}}) {
    if(this.closed||this.clients.has(key))throw new Error('弹幕服务已关闭或重复启动。');
    if(this.clients.size>=64)throw new Error('同时录制的抖音房间过多。');
    const client={details,write,status,health:new DouyinChatHealth(),pending:Promise.resolve(),stopping:false};this.clients.set(key,client);
    this.ensureWorker();this.worker.postMessage({type:'start',key,...details});
    client.health.started();
  }
  snapshot(key){return this.clients.get(key)?.health.snapshot??null;}
  update(key,{cookie,userUniqueId},{reauthenticate=false}={}) {
    const client=this.clients.get(key);if(!client||client.stopping)return;
    if(!reauthenticate&&client.details.cookie===cookie&&client.details.userUniqueId===userUniqueId)return;
    Object.assign(client.details,{cookie,userUniqueId});this.worker?.postMessage({type:'credentials',key,cookie,userUniqueId,reauthenticate});
  }
  ensureWorker() {
    if(this.worker||this.closed)return;
    const worker=this.createWorker();this.worker=worker;this.lastHeartbeat=Date.now();worker.postMessage({type:'configure',rateLimit:this.rateLimit});
    worker.on('message',message=>{
      if(this.worker!==worker)return;this.lastHeartbeat=Date.now();
      const client=this.clients.get(message.key);
      if(message.type==='batch'){
        if(!client){worker.postMessage({type:'ack',key:message.key,id:message.id});return;}
        const epoch=client.health.epoch;
        client.pending=client.pending.then(async()=>{
          await client.write(message);
          const hasRecords=(message.messages?.length||0)+(message.gifts?.length||0)>0,recovered=client.health.writeFailed;
          if(hasRecords)client.health.completedWrite(epoch);
          // Reuse the existing success signal after a recovered write as well,
          // so recorder warnings clear only after data has actually been saved.
          if(hasRecords&&(!client.firstWrite||recovered)){client.firstWrite=true;client.status('first-write',{stage:'write'});}
        }).catch(()=>{client.health.failedWrite();client.status('write-failed',{stage:'write',reason:'write'});}).finally(()=>{
          if(this.worker===worker)worker.postMessage({type:'ack',key:message.key,id:message.id});
        });
      }else if(message.type==='status'){const event=safeChatStatus(message.status,message);if(event){client?.health.update(event.status);client?.status(event.status,event);}}
      else if(message.type==='stopped')client?.resolveStop?.();
    });
    const failed=(reason='worker-exit')=>{
      if(this.worker!==worker)return;this.worker=null;clearInterval(this.watchdog);void worker.terminate();
      for(const client of this.clients.values()){client.health.update('retry');client.status('retry',{stage:'worker',reason:reason==='worker-timeout'?reason:'worker-exit',retryMs:2000});if(client.stopping)client.resolveStop?.();}
      if(!this.closed&&[...this.clients.values()].some(client=>!client.stopping))this.retry=setTimeout(()=>{
        this.retry=null;this.ensureWorker();for(const [key,client]of this.clients)if(!client.stopping)this.worker?.postMessage({type:'start',key,...client.details});
      },2000);
    };
    worker.on('error',()=>failed());worker.on('exit',()=>failed());
    this.watchdog=setInterval(()=>{if(Date.now()-this.lastHeartbeat>this.timeoutMs)failed('worker-timeout');},2000);
  }
  async stop(key) {
    const client=this.clients.get(key);if(!client)return;
    if(client.stop)return client.stop;
    client.stopping=true;client.health.stop();
    client.stop=(async()=>{
      if(this.worker){let timer;await new Promise(resolve=>{
        client.resolveStop=()=>{clearTimeout(timer);resolve();};
        // A stuck decoder must not indefinitely keep a recording open.
        timer=setTimeout(()=>{const worker=this.worker;if(worker)void worker.terminate();client.resolveStop();},5000);
        this.worker.postMessage({type:'stop',key});
      });}
      await client.pending;this.clients.delete(key);
      if(!this.clients.size){clearTimeout(this.retry);clearInterval(this.watchdog);const worker=this.worker;this.worker=null;await worker?.terminate();}
    })();return client.stop;
  }
  async close(){this.closed=true;clearTimeout(this.retry);await Promise.all([...this.clients.keys()].map(key=>this.stop(key)));clearInterval(this.watchdog);const worker=this.worker;this.worker=null;await worker?.terminate();}
}
