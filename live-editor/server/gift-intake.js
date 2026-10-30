// Gifts have an independent bounded queue: chat sampling must not sample away
// a paid event. Repeated combo updates replace the cumulative count, not add it.
export class GiftIntake{
  constructor({maxBytes=16*1024*1024,perRoom=512}={}){this.rooms=new Map();this.bytes=0;this.maxBytes=maxBytes;this.perRoom=perRoom;}
  start(key){this.rooms.set(key,{pending:new Map(),seen:new Map(),count:0,closed:false});}
  add(key,gift){
    const room=this.rooms.get(key);if(!room||room.closed||!gift||gift.id.length>160)return false;
    const previous=room.seen.get(gift.id);if(previous&&gift.count<=previous.count)return true;
    const firstTime=previous?.time??gift.time,item={...gift,time:firstTime};
    const size=Buffer.byteLength(JSON.stringify(item))+128,old=room.pending.get(gift.id);
    if(size>8192||!old&&room.count>=this.perRoom||this.bytes+size-(old?.size||0)>this.maxBytes)return false;
    room.pending.set(gift.id,{item,size});this.bytes+=size-(old?.size||0);if(!old)room.count++;
    room.seen.set(gift.id,{count:gift.count,time:firstTime});
    while(room.seen.size>10000)room.seen.delete(room.seen.keys().next().value);
    return true;
  }
  take(key){
    const room=this.rooms.get(key);if(!room||!room.pending.size)return null;
    const entries=[...room.pending.entries()].slice(0,128);for(const [id]of entries)room.pending.delete(id);
    let released=false;return {gifts:entries.map(([,entry])=>entry.item),release:()=>{if(released)return;released=true;for(const [,entry]of entries){this.bytes-=entry.size;room.count--;}}};
  }
  stop(key){const room=this.rooms.get(key);if(room)room.closed=true;}
  drop(key){const room=this.rooms.get(key);if(!room)return;for(const entry of room.pending.values())this.bytes-=entry.size;this.rooms.delete(key);}
}
