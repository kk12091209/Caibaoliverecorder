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
    this.runtime.quitError='';
    this.runtime.stopping=true;this.runtime.request('quit');this.accepted=true;
    const prepared=this.preparation.close();
    this.completion=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
      await Promise.all([this.recorder.stopForExit(rooms),prepared]);
      await this.close();
    });
    // Keep errors observable for tests/maintenance without an unhandled rejection.
    // Keep the authenticated endpoint alive if stopping the core fails. The
    // desktop must report the failure and allow another quit attempt rather
    // than disappearing while a recorder keeps running.
    this.completion.catch(error=>{this.runtime.diagnostics?.record('安全退出',error,{level:'错误'});this.runtime.lastError=error.message;this.runtime.quitError=error.message;this.accepted=false;});
    return {quitAccepted:true,requiresExitConfirmation:false};
  }
}
