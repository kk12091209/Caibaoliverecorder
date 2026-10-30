import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
export function installSenders(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS danmaku_senders(message TEXT PRIMARY KEY REFERENCES danmaku(id) ON DELETE CASCADE,platform TEXT NOT NULL,uid TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS dm_sender ON danmaku_senders(platform,uid,message);
 CREATE TABLE IF NOT EXISTS sender_index_sources(source TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,pos INTEGER NOT NULL);
`);store.senders=new SenderIndex(store);}
export const xmlAttributes=text=>Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2].replace(/&#x([0-9a-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi,(_,x,d,n)=>x||d?String.fromCodePoint(Math.min(0x10ffff,parseInt(x||d,x?16:10))):({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'}[n]||''))]));
export function senderFromXml(attributes,source,store){
 const platform=attributes.platform==='douyin'||store.setting('douyin-session:'+source.session)?'douyin':'bilibili';
 // Old Douyin XML used uid for the message ID. Never mistake it for a user ID.
 const id=platform==='douyin'?attributes.sender_id:(attributes.p||'').split(',')[6];
 return /^[1-9]\d{0,30}$/.test(id||'')?{platform,uid:id}:null;
}
export function saveSender(store,message,sender){if(sender)store.run('INSERT OR IGNORE INTO danmaku_senders SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM danmaku WHERE id=?)',message,sender.platform,sender.uid,message);}
export class SenderIndex{
 constructor(store){this.store=store;this.pending=new Map();}
 prepare(session){if(this.pending.has(session))return this.pending.get(session);const work=this.scan(session).finally(()=>this.pending.delete(session));this.pending.set(session,work);return work;}
 async scan(session){
  for(const source of this.store.sources(session)){
   if(this.store.closed||!this.store.session(session))return;
   let pos=this.store.get('SELECT pos FROM sender_index_sources WHERE source=?',source.id)?.pos||0;
   if(pos>=source.xmlpos)continue;
   let file;try{file=await fs.open(source.xml,'r');}catch(e){if(e.code==='ENOENT')continue;throw e;}
   try{while(pos<source.xmlpos&&!this.store.closed&&this.store.session(session)){
    const bytes=Buffer.alloc(Math.min(256*1024,source.xmlpos-pos));const {bytesRead}=await file.read(bytes,0,bytes.length,pos);if(!bytesRead)break;
    const text=bytes.subarray(0,bytesRead).toString('utf8'),rows=[];let consumed=0;
    // Match every event so a closed file without ordinary chats still advances.
    for(const m of text.matchAll(/<(d|sc|gift|guard|density)\s+([^>]*?)(?:\/>|>[\s\S]*?<\/\1>)/g)){
     consumed=m.index+m[0].length;if(m[1]!=='d')continue;
     const id=createHash('sha256').update(`${source.id}:${pos+Buffer.byteLength(text.slice(0,m.index))}`).digest('hex').slice(0,32);
     rows.push([id,senderFromXml(xmlAttributes(m[2]),source,this.store)]);
    }
    if(!consumed)break;
    if(this.store.closed||!this.store.session(session))break;
    pos+=Buffer.byteLength(text.slice(0,consumed));this.store.transaction(()=>{for(const [id,sender] of rows)saveSender(this.store,id,sender);this.store.run('INSERT INTO sender_index_sources VALUES(?,?) ON CONFLICT(source) DO UPDATE SET pos=excluded.pos',source.id,pos);});
    await yieldTurn();
   }}finally{await file.close();}
  }
 }
 async close(){await Promise.allSettled([...this.pending.values()]);}
}
