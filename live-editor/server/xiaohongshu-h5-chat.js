import {createHash} from 'node:crypto';
import {readBoundedResponse} from './douyin-room.js';
import {parsePlatformJson} from './linkmic-sei.js';
import {XHS_USER_AGENT} from './xiaohongshu-room.js';

// The public mobile viewer polls this bounded interaction feed. It does not
// expose a verified structured gift protocol, so only its comment text is used.
export class XiaohongshuH5Chat{
  constructor({request=fetch,now=Date.now}={}){
    Object.assign(this,{request,now});
    this.clients=new Map();
    this.closed=false;
  }
  start(key,details,callbacks){
    if(this.closed||this.clients.has(key)||this.clients.size>=64)throw Error('小红书弹幕服务暂时不可用。');
    const client={details,callbacks,abort:new AbortController(),connection:'connecting',seen:new Set(),cursor:this.now(),error:''};
    this.clients.set(key,client);
    void this.poll(key,client);
  }
  snapshot(key){
    const client=this.clients.get(key);
    return client?{connection:client.connection,error:client.error}:null;
  }
  async poll(key,client){
    if(this.closed||client.abort.signal.aborted)return;
    let wait=5000;
    client.pending=(async()=>{
      try{
        const query=new URLSearchParams({roomId:client.details.roomId,startTimestamp:String(client.cursor),size:'10',needPraise:'true',needViewer:'true'});
        const response=await this.request('https://live-room.xiaohongshu.com/api/sns/red/live/h5/v1/interaction/get_simple_interaction?'+query,{
          signal:AbortSignal.any([client.abort.signal,AbortSignal.timeout(8000)]),redirect:'error',
          headers:{'User-Agent':XHS_USER_AGENT,Referer:'https://www.xiaohongshu.com/'},
        });
        if(!response.ok){
          const restricted=[401,403,406,429,461,471].includes(response.status);
          await response.body?.cancel();
          throw Error(restricted?'小红书弹幕接口访问受限，录像继续采集。':'小红书弹幕请求失败，将稍后重试。');
        }
        const text=await readBoundedResponse(response,256*1024).catch(()=>{throw Error('小红书弹幕响应无法完整读取，录像继续采集。');});
        const result=parsePlatformJson(text);
        if(result?.success!==true||!Array.isArray(result.data?.comments))throw Error('小红书弹幕响应待确认，录像继续采集。');
        const data=result.data,received=this.now(),messages=[],batchIds=new Set();
        if(!Number.isSafeInteger(data.endTimestamp)||data.endTimestamp<client.cursor||data.comments.length>100)throw Error('小红书弹幕时间游标无效。');
        for(const [index,comment] of data.comments.entries()){
          if(typeof comment?.desc!=='string'||!comment.desc||comment.desc.length>10000)continue;
          // The public feed has no verified message identifier. Bind retries
          // to their cursor and array slot, never deduplicate by text or name.
          const id='xhs-'+createHash('sha256').update(JSON.stringify([client.cursor,data.endTimestamp,index,comment])).digest('hex');
          if(client.seen.has(id)||batchIds.has(id))continue;
          batchIds.add(id);
          messages.push({id,time:Math.max(0,(received-client.details.sourceStart)/1000),
            text:comment.desc,user:String(comment.profile?.nickname||'').slice(0,200),color:'16777215',
            ...(/^[a-f0-9]{24}$/.test(comment.profile?.userId||'')?{senderId:comment.profile.userId}:{})});
        }
        await client.callbacks.write({messages,density:[],gifts:[]});
        if(client.abort.signal.aborted)return;
        for(const message of messages)client.seen.add(message.id);
        while(client.seen.size>2000)client.seen.delete(client.seen.values().next().value);
        client.cursor=data.endTimestamp;
        client.connection='connected';client.error='';
        client.callbacks.status('connected');
        if(messages.length)client.callbacks.status('first-write');
        wait=Math.max(5000,Math.min(30000,Number(data.nextRequestInterval)||5000));
      }catch(error){
        if(client.abort.signal.aborted)return;
        client.connection='retrying';
        client.error=error.message;
        wait=30000;
        client.callbacks.status('retry');
      }
    })();
    await client.pending;
    if(!this.closed&&!client.abort.signal.aborted)client.timer=setTimeout(()=>{void this.poll(key,client);},wait);
  }
  async stop(key){
    const client=this.clients.get(key);
    if(!client)return;
    client.abort.abort();clearTimeout(client.timer);
    await client.pending;
    this.clients.delete(key);
  }
  async close(){this.closed=true;await Promise.all([...this.clients.keys()].map(key=>this.stop(key)));}
}
