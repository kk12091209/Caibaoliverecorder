import {Worker} from 'node:worker_threads';
import { DEFAULT_CHAT_RATE, validateChatRate } from './chat-rules.js';

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
    const client={details,write,status,pending:Promise.resolve(),stopping:false};this.clients.set(key,client);
    this.ensureWorker();this.worker.postMessage({type:'start',key,...details});
  }
  update(key,{cookie,userUniqueId}) {
    const client=this.clients.get(key);if(!client||client.stopping)return;
    if(client.details.cookie===cookie&&client.details.userUniqueId===userUniqueId)return;
    Object.assign(client.details,{cookie,userUniqueId});this.worker?.postMessage({type:'credentials',key,cookie,userUniqueId});
  }
  ensureWorker() {
    if(this.worker||this.closed)return;
    const worker=this.createWorker();this.worker=worker;this.lastHeartbeat=Date.now();worker.postMessage({type:'configure',rateLimit:this.rateLimit});
    worker.on('message',message=>{
      if(this.worker!==worker)return;this.lastHeartbeat=Date.now();
      const client=this.clients.get(message.key);
      if(message.type==='batch'){
        if(!client){worker.postMessage({type:'ack',key:message.key,id:message.id});return;}
        client.pending=client.pending.then(()=>client.write(message)).catch(()=>client.status('write-failed')).finally(()=>{
          if(this.worker===worker)worker.postMessage({type:'ack',key:message.key,id:message.id});
        });
      }else if(message.type==='status')client?.status(message.status);
      else if(message.type==='stopped')client?.resolveStop?.();
    });
    const failed=()=>{
      if(this.worker!==worker)return;this.worker=null;clearInterval(this.watchdog);void worker.terminate();
      for(const client of this.clients.values()){client.status('retry');if(client.stopping)client.resolveStop?.();}
      if(!this.closed&&[...this.clients.values()].some(client=>!client.stopping))this.retry=setTimeout(()=>{
        this.retry=null;this.ensureWorker();for(const [key,client]of this.clients)if(!client.stopping)this.worker?.postMessage({type:'start',key,...client.details});
      },2000);
    };
    worker.on('error',failed);worker.on('exit',failed);
    this.watchdog=setInterval(()=>{if(Date.now()-this.lastHeartbeat>this.timeoutMs)failed();},2000);
  }
  async stop(key) {
    const client=this.clients.get(key);if(!client)return;
    if(client.stop)return client.stop;
    client.stopping=true;
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
