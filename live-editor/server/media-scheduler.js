const aborted = () => Object.assign(new Error('媒体处理已取消。'), { name:'AbortError' });

// Reserve room for interaction while bounding all decoders/encoders together.
// Recording itself never enters this queue and reduces background CPU demand.
export class MediaScheduler {
  constructor({ recording = () => false, backgroundLimit = () => 1, foregroundLimit = () => 2 } = {}) {
    this.recording=recording;this.backgroundLimit=backgroundLimit;this.foregroundLimit=foregroundLimit;this.queue=[];this.active=new Set();this.closed=false;this.timer=null;
  }
  run(kind, signal, work, measured) {
    if(this.closed||signal?.aborted)return Promise.reject(aborted());
    if(this.queue.length>=64)return Promise.reject(new Error('媒体任务较多，请稍后重试。'));
    return new Promise((resolve,reject)=>{
      const item={kind,signal,work,measured,resolve,reject,queued:performance.now()};
      item.abort=()=>{const i=this.queue.indexOf(item);if(i>=0){this.queue.splice(i,1);reject(aborted());this.drain();}};
      signal?.addEventListener('abort',item.abort,{once:true});this.queue.push(item);this.drain();
    });
  }
  drain() {
    if(this.closed)return;
    const recording=this.recording(),foreground=recording?1:Math.max(2,Math.min(4,this.foregroundLimit())),limit=recording?2:foreground+1;
    while(!this.closed&&this.active.size<limit) {
      const renders=[...this.active].filter(item=>item.kind!=='interactive').length;
      const interactive=[...this.active].filter(item=>item.kind==='interactive').length;
      const backgrounds=[...this.active].filter(item=>item.kind==='background').length;
      const liveBackgrounds=[...this.active].filter(item=>item.kind==='live-background').length;
      let next=-1;
      for(const kind of ['interactive','foreground','live-background','background']) {
        if(kind==='interactive'?interactive>=2:renders>=(kind==='foreground'?foreground:recording?1:2))continue;
        // Only explicitly admitted live work gets this slot. Interactive and
        // foreground arrivals still win; ordinary background stays blocked.
        if(kind==='live-background'&&(liveBackgrounds||renders||interactive))continue;
        if(kind==='background'&&(recording||renders>backgrounds||backgrounds>=Math.min(2,Math.max(1,this.backgroundLimit()))))continue;
        next=this.queue.findIndex(item=>item.kind===kind);if(next>=0)break;
      }
      if(next<0)break;
      const item=this.queue.splice(next,1)[0];item.signal?.removeEventListener('abort',item.abort);this.active.add(item);
      const started=performance.now();
      const finish=(error,value)=>{
        this.active.delete(item);item.measured?.({waitMs:started-item.queued,workMs:performance.now()-started});this.drain();
        if(error)item.reject(error);else item.resolve(value);
      };
      Promise.resolve().then(()=>{if(this.closed||item.signal?.aborted)throw aborted();return item.work();}).then(value=>finish(null,value),error=>finish(error));
    }
    // Also wake a queued background task when recording ends without a process
    // completion. This timer exists only while waiting and never keeps Node alive.
    if(this.queue.length&&!this.timer&&!this.closed){this.timer=setTimeout(()=>{this.timer=null;this.drain();},200);this.timer.unref?.();}
    if(!this.queue.length){clearTimeout(this.timer);this.timer=null;}
  }
  close() {
    this.closed=true;clearTimeout(this.timer);
    for(const item of this.queue.splice(0)){item.signal?.removeEventListener('abort',item.abort);item.reject(aborted());}
  }
}
