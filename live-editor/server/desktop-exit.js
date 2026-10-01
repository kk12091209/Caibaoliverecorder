// User exit is distinct from maintenance/restart: stop work and retain enough
// state to resume it, while allowing the desktop to close on acknowledgement.
export class DesktopExit {
  constructor({runtime,activity,recorder,media,preparation,close}){Object.assign(this,{runtime,activity,recorder,media,preparation,close});this.accepted=false;this.preparing=null;this.completion=null;}
  request(confirmed=false){
    if(typeof confirmed!=='boolean')throw new Error('请确认是否退出。');
    if(this.accepted)return Promise.resolve({quitAccepted:true,requiresExitConfirmation:false});
    return this.preparing??=this.prepare(confirmed).finally(()=>{this.preparing=null;});
  }
  async prepare(confirmed){
    if(!confirmed&&this.activity().requiresExitConfirmation)return {quitAccepted:false,requiresExitConfirmation:true};
    const rooms=await this.recorder.roomsForExit();
    // Check again after the core query; an export or recording may have begun
    // while the user was deciding. Rejection must not stop or alter any work.
    if(!confirmed&&(this.activity().requiresExitConfirmation||rooms.some(room=>room.recording)))return {quitAccepted:false,requiresExitConfirmation:true};
    this.recorder.rememberExitRooms(rooms);
    this.media.suspendForExit();
    this.runtime.stopping=true;this.runtime.request('quit');this.accepted=true;
    const prepared=this.preparation.close();
    this.completion=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
      try{await this.recorder.stopForExit(rooms);}
      catch(error){this.runtime.lastError=error.message;}
      await prepared;
      await this.close();
    });
    // Keep errors observable for tests/maintenance without an unhandled rejection.
    this.completion.catch(error=>{this.runtime.lastError=error.message;});
    return {quitAccepted:true,requiresExitConfirmation:false};
  }
}
