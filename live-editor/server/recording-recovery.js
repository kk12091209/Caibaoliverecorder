// A second guard for cores that still report Recording after useful output stops.
// The core handles short outages; this guard never terminates the shared process.
export class RecordingRecovery {
  constructor({now=()=>performance.now(),report=()=>{}}={}) {
    this.now=now;this.report=report;this.rooms=new Map();
  }
  forget(id){this.rooms.delete(id);}
  prune(ids){for(const id of this.rooms.keys())if(!ids.has(id))this.forget(id);}
  observe(raw,enabled) {
    const id=raw.roomId,now=this.now();
    if(!enabled){this.forget(id);return null;}
    let state=this.rooms.get(id);
    // Finish an acknowledged stop before considering live status or progress.
    if(state?.phase==='stopping')return this.updateHealth(state,now);
    // No task can also mean a core policy (title filter, encrypted room, full
    // disk). Do not override it. Only resume a stop that this guard owns.
    if(!raw.recording&&state?.phase!=='verifying'){this.forget(id);return null;}
    if(!raw.recording&&!raw.streaming){this.forget(id);return null;}
    const stats=raw.recordingStats,io=raw.ioStats;
    const sample={bytes:Number(stats?.totalOutputBytes)||0,time:Number(stats?.sessionMaxTimestamp)||0,
      disk:Number(io?.diskBytesWritten)||0,ioEnd:io?.endTime};
    if(!state){state={id,last:now,attempt:-Infinity,phase:'watching',sample,health:null};this.rooms.set(id,state);}
    else {
      const previous=state.sample;
      // Counter resets (new recording task) alone do not prove recovery.
      const progressed=raw.recording&&(sample.bytes>previous.bytes&&sample.time>previous.time ||
        sample.bytes===0&&sample.time===0&&sample.disk>0&&sample.ioEnd&&sample.ioEnd!==previous.ioEnd);
      state.sample=sample;
      if(progressed){
        if(state.incident!==undefined)this.report(id,`有效录制已恢复；距最后观察到推进约 ${Math.round((now-state.incident)/1000)} 秒（含监控采样间隔）`);
        state.last=now;state.phase='watching';delete state.incident;
      }
    }
    // Older cores/mocks without counters cannot provide a reliable progress signal.
    if(raw.recording&&!stats&&!io){this.forget(id);return null;}
    return this.updateHealth(state,now);
  }
  updateHealth(state,now) {
    const idle=now-state.last;
    if(idle>=8000&&state.incident===undefined){state.incident=state.last;this.report(state.id,'有效录制进度暂未推进，正在监测恢复','警告');}
    const phase=state.phase;
    state.health=phase==='stopping'?{state:'recovering',message:now-state.attempt>=10000?'等待旧录制安全停止 · 正在恢复':'录制异常 · 正在重连'}
      :phase==='verifying'?{state:'recovering',message:'正在恢复 · 等待有效录制'}
      :idle>=8000?{state:'stalled',message:'录制进度停滞 · 正在恢复'}:null;
    return state;
  }
  action(id,raw) {
    const state=this.rooms.get(id),now=this.now();if(!state)return null;
    if(state.phase==='stopping'&&!raw.recording)return 'start';
    if(now-state.last<30000||now-state.attempt<30000)return null;
    return raw.recording?'stop':raw.streaming?'start':null;
  }
  requested(id,action) {
    const state=this.rooms.get(id);if(!state)return;
    const now=this.now();state.incident??=state.last;state.attempt=now;
    state.phase=action==='stop'?'stopping':'verifying';
    if(action==='start'){state.last=now;state.sample={bytes:0,time:0,disk:0};}
    this.report(id,action==='stop'?'有效录制持续未推进，停止当前任务后重连；保留已录文件':'旧任务已停止，重新请求录制；等待有效内容确认恢复','警告');
    this.updateHealth(state,now);
  }
  health(id){return this.rooms.get(id)?.health??null;}
}
