import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function roomEnabled(room) {
  return !!room.recording || (typeof room.recordingEnabled==='boolean'
    ? room.recordingEnabled : !!room.autoRecord && room.autoRecordForThisSession!==false);
}
const validId=id=>Number.isInteger(id)&&id>0&&id<=2147483647;

// User intent survives core exits. The core's AutoRecordForThisSession does not.
export class BilibiliRooms {
  constructor(store) {
    this.store=store;this.entries=new Map();this.operations=new Map();
    const saved=store.setting('bilibili-rooms');
    for(const room of Array.isArray(saved)?saved:[])if(room&&validId(room.roomId)&&typeof room.enabled==='boolean'){
      this.entries.set(room.roomId,{roomId:room.roomId,enabled:room.enabled,autoRecord:room.autoRecord!==false,
        shortId:validId(room.shortId)?room.shortId:0,name:String(room.name||'').slice(0,100),title:String(room.title||'').slice(0,300)});
    }
  }
  save(){this.store.setting('bilibili-rooms',[...this.entries.values()]);}
  get(id){return this.entries.get(id)||(validId(id)?[...this.entries.values()].find(room=>room.shortId===id):undefined);}
  set(id,patch){const room=this.get(id);if(!room)throw new Error('直播间不存在或已移除。');Object.assign(room,patch);this.save();return room;}
  remove(id){const room=this.get(id);if(room)this.entries.delete(room.roomId);this.save();}
  capture(rooms,{resume=[],prune=false}={}) {
    let changed=false;
    for(const raw of rooms){
      if(!validId(raw.roomId))continue;
      let room=this.entries.get(raw.roomId);
      // The core resolves a short room number to its permanent ID asynchronously.
      if(!room&&validId(raw.shortId)&&raw.shortId!==raw.roomId){
        room=this.entries.get(raw.shortId);
        if(room){this.entries.delete(room.roomId);room.roomId=raw.roomId;this.entries.set(room.roomId,room);changed=true;}
      }
      if(!room){
        const enabled=typeof raw.recordingEnabled==='boolean'?raw.recordingEnabled
          : raw.autoRecordForThisSession===false?false:!!raw.recording||!!raw.autoRecord||resume.includes(raw.roomId);
        room={roomId:raw.roomId,enabled,autoRecord:!!raw.autoRecord,shortId:0,name:'',title:''};
        this.entries.set(raw.roomId,room);changed=true;
      }
      if(validId(raw.shortId)&&room.shortId!==raw.shortId){room.shortId=raw.shortId;changed=true;}
      for(const [key,length] of [['name',100],['title',300]])if(typeof raw[key]==='string'){
        const value=raw[key].slice(0,length);if(room[key]!==value){room[key]=value;changed=true;}
      }
    }
    if(prune){const ids=new Set(rooms.map(room=>room.roomId));for(const id of this.entries.keys())if(!ids.has(id)&&!this.operations.has(id)){this.entries.delete(id);changed=true;}}
    if(changed)this.save();
    return rooms.map(raw=>this.project(raw));
  }
  project(raw){const room=this.get(raw.roomId);return room?{...raw,autoRecord:room.autoRecord,recordingEnabled:room.enabled,autoRecordForThisSession:room.enabled}:raw;}
  snapshot(){return [...this.entries.values()].map(room=>this.project({...room,name:room.name||`直播间 ${room.roomId}`,streaming:false,recording:false}));}
  async serial(id,action) {
    if(!validId(id))throw new Error('直播间编号无效。');
    const previous=this.operations.get(id);
    const pending=(previous||Promise.resolve()).catch(()=>{}).then(action);
    this.operations.set(id,pending);
    try{return await pending;}finally{if(this.operations.get(id)===pending)this.operations.delete(id);}
  }
  async prepareLaunch(directory,assertOpen) {
    // Runs only before launching an absent core, never while its config writer is live.
    // Persisted stops also win when a preceding HTTP stop/config request failed.
    const file=path.join(directory,'config.json'),config=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
    if(config.version!==3||!Array.isArray(config.rooms))throw new Error('录制核心配置无效，已保留原文件。');
    let changed=false;
    for(const raw of config.rooms){
      const id=raw.RoomId?.Value,room=this.get(id);
      if(room&&(!room.enabled||!room.autoRecord)&&!(raw.AutoRecord?.HasValue===true&&raw.AutoRecord.Value===false)){
        raw.AutoRecord={HasValue:true,Value:false};changed=true;
      }
    }
    if(!changed)return;
    const temporary=path.join(directory,`.config-start-${randomUUID()}.tmp`);
    try{assertOpen();await fs.writeFile(temporary,JSON.stringify(config,null,2),{flag:'wx'});assertOpen();await fs.rename(temporary,file);}
    finally{await fs.rm(temporary,{force:true});}
  }
}
