import os from 'node:os';
import {monitorEventLoopDelay} from 'node:perf_hooks';

const MiB=1024**2;
const liveSessions = "SELECT id,room,status,error,duration FROM sessions WHERE deleted_at='' AND status IN ('recording','waiting')";
const finite=value=>Number.isFinite(value)&&value>=0;

// Read-only admission telemetry. Nothing here participates in a writer's await
// chain, and unavailable observations never count as a healthy recording.
export class LiveRecordingHealth {
  constructor({store,recorder,ingestor,media,blocked=()=>false,resources=async()=>null,
    now=Date.now,platform=process.platform,loopMonitor=()=>monitorEventLoopDelay({resolution:20})}={}) {
    Object.assign(this,{store,recorder,ingestor,media,blocked,resources,now,platform,loopMonitor});
    this.progress=new Map();this.backlog=new Map();this.monitor=null;this.closed=false;
  }
  loopDelay() {
    if(!this.monitor){this.monitor=this.loopMonitor();this.monitor.enable();return 0;}
    const delay=Number(this.monitor.max)/1e6;this.monitor.reset();return finite(delay)?delay:undefined;
  }
  recordingProgress(room,sourceId,at) {
    const telemetry=['douyin','xiaohongshu'].includes(room.platform)?room.recordingProgress:{
      observedAt:room.recordingObservedAt,bytes:room.recordingStats?.totalOutputBytes,
      mediaMs:room.recordingStats?.sessionMaxTimestamp};
    if(!telemetry||!finite(telemetry.observedAt)||!finite(telemetry.bytes)||!finite(telemetry.mediaMs))return 'observing';
    const key=room.platform+':'+room.roomId,previous=this.progress.get(key);
    let state=previous;
    if(!state||state.source!==sourceId||telemetry.bytes<state.bytes||telemetry.mediaMs<state.mediaMs){
      state={source:sourceId,bytes:telemetry.bytes,mediaMs:telemetry.mediaMs,started:at,advanced:null};
      this.progress.set(key,state);
    } else if(telemetry.bytes>state.bytes&&telemetry.mediaMs>state.mediaMs){
      state.bytes=telemetry.bytes;state.mediaMs=telemetry.mediaMs;state.advanced=telemetry.observedAt;
    }
    while(this.progress.size>64)this.progress.delete(this.progress.keys().next().value);
    if(telemetry.observedAt>at+1000||at-telemetry.observedAt>8000)return 'unhealthy';
    if(at-(state.advanced??state.started)>=8000)return 'unhealthy';
    return state.advanced===null?'observing':'healthy';
  }
  matches(session, room) {
    return ['douyin','xiaohongshu'].includes(room.platform)
      ? session.room===0&&this.store.setting(room.platform+'-session:'+session.id)?.webRid===room.webRid
      : session.room>0&&(Number(room.roomId)===session.room||Number(room.shortId)===session.room);
  }
  writer(session, room, at) {
    const sources=this.store.sources(session.id),open=sources.filter(source=>source.closed===0);
    if(session.status!=='recording'||session.error||room.error||room.recordingHealth||sources.some(source=>source.error))return {recordingState:'unhealthy'};
    if(open.length!==1)return {recordingState:'observing'};
    const source=open[0],recordingState=this.recordingProgress(room,source.id,at);
    const ingest=this.ingestor.healthSnapshot?.(source.id);
    if(!ingest||!finite(ingest.observedAt)||ingest.observedAt>at+1000||at-ingest.observedAt>8000){
      return {recordingState:ingest?'unhealthy':'observing'};
    }
    if(!finite(ingest.unreadBytes)||!finite(ingest.writeLatencyMs))return {recordingState:'observing'};
    const pending=ingest.unreadBytes>MiB;
    if(pending&&!this.backlog.has(source.id))this.backlog.set(source.id,at);
    if(!pending)this.backlog.delete(source.id);
    while(this.backlog.size>64)this.backlog.delete(this.backlog.keys().next().value);
    const ingestLagMs=pending?Math.max(0,at-this.backlog.get(source.id)):0;
    const writer=['douyin','xiaohongshu'].includes(room.platform)?room.recordingProgress:null;
    const recordingWriteHealthy=ingest.writeLatencyMs<=500&&
      (!finite(ingest.inFlightWriteSince)||at-ingest.inFlightWriteSince<=500)&&
      (!writer||(finite(writer.writeLatencyMs)&&writer.writeLatencyMs<=500&&
        (!finite(writer.inFlightWriteSince)||at-writer.inFlightWriteSince<=500)));
    let header;try{header=JSON.parse(source.header);}catch{}
    return {recordingState,recordingHealthy:recordingState==='healthy',recordingWriteHealthy,ingestLagMs,
      sourceReady:source.duration>=150&&!!header?.video&&!!header?.audio};
  }
  automaticWorkHealthy(evidence=this.publicationState()) {
    return evidence.state==='healthy' && os.availableParallelism()>=4;
  }

  publicationState() {
    const at=this.now();
    const sessions=this.store.all(liveSessions),rooms=this.recorder.rooms.filter(room=>room.recording);
    if (!sessions.length && !rooms.length) {
      this.unmatchedSince = undefined;
      this.observingSince = undefined;
      return {state:'idle'};
    }
    if (this.closed) return {state:'paused',reason:'录制状态检查已关闭'};
    if (rooms.length !== sessions.length || !sessions.length) {
      this.unmatchedSince ??= at;
      const waiting = sessions.find(session=>session.status==='waiting') ||
        (at - this.unmatchedSince >= 8_000);
      return {state:waiting?'paused':'observing',reason:waiting?'等待录制重连':'正在确认新录制'};
    }
    this.unmatchedSince = undefined;
    if (this.platform === 'darwin') this.samplePublicationMemory(at);
    const writers=rooms.map(room=>{
      const session=sessions.find(candidate=>this.matches(candidate,room));
      return {room:String(room.webRid||room.roomId),health:session&&this.writer(session,room,at)};
    });
    const stalled=writers.find(({health})=>health?.recordingState==='unhealthy');
    if (stalled) return {state:'paused',reason:'录制进度停滞或正在重连',room:stalled.room};
    const observing=writers.find(({health})=>!health||health.recordingState==='observing');
    if (observing) {
      this.observingSince ??= at;
      return {state:at-this.observingSince>=8_000?'paused':'observing',reason:'等待录制写入观测',room:observing.room};
    }
    this.observingSince = undefined;
    const slow=writers.find(({health})=>!health.recordingWriteHealthy||health.ingestLagMs>5000);
    if (slow) return {state:'pressure',reason:'录制写入变慢或索引积压',room:slow.room};
    if (this.loopDelay()>250) return {state:'pressure',reason:'后台响应变慢'};
    // On macOS immediately-free pages exclude reclaimable file cache. Share
    // the existing bounded memory-pressure sampler used by the render queue.
    if(this.platform==='darwin'){
      const sample=this.automaticMemory;
      if (!sample||at-sample.at>35000||!finite(sample.bytes))return {state:'observing',reason:'等待系统资源观测'};
      if (sample.bytes<768*MiB)return {state:'pressure',reason:'可用内存偏低'};
    } else if(os.freemem()<768*MiB)return {state:'pressure',reason:'可用内存偏低'};
    if (os.availableParallelism()<4) return {state:'observing',reason:'录制期间保守上传'};
    return {state:'healthy'};
  }
  samplePublicationMemory(at) {
    if (this.automaticMemoryPending || this.automaticMemory && at - this.automaticMemory.at < 5000) return;
    this.automaticMemoryPending = Promise.resolve().then(()=>this.media.idlePolicy?.resources())
      .then(value=>{ this.automaticMemory={at:this.now(),bytes:value?.available}; },
        ()=>{ this.automaticMemory={at:this.now(),bytes:undefined}; })
      .finally(()=>{ this.automaticMemoryPending=null; });
  }

  async context() {
    const at=this.now(),base={recordingCount:0,recordingState:'observing',recordingHealthy:false,
      recordingWriteHealthy:false,hardwareAvailable:this.hardwareAvailable===true,sourceReady:false,foreground:this.closed||!!this.blocked()};
    if(this.closed)return base;
    base.loopDelayMs=this.loopDelay();
    const sessions=this.store.all(liveSessions),rooms=this.recorder.rooms.filter(room=>room.recording);
    base.recordingCount=Math.max(sessions.length,rooms.length);
    if(sessions.length!==1||rooms.length!==1)return base;
    const session=sessions[0],room=rooms[0];
    if(!this.matches(session,room))return base;
    base.sessionId=session.id;base.recordingIdentity=session.id;
    Object.assign(base,this.writer(session,room,at));
    if(!base.recordingHealthy||!base.recordingWriteHealthy||base.foreground||base.ingestLagMs>15000||base.loopDelayMs>250||this.platform!=='darwin')return base;
    if(this.hardwareAvailable!==undefined)return base;
    // Probe hardware only on a healthy, powered device. The shared resource
    // sampler and Media cache bound the cost, including unavailable hardware.
    const resource=await this.resources();
    if(!resource?.supported||resource.acPower!==true||resource.lowPowerMode!==false||resource.thermal!=='nominal'||
      !finite(resource.sampledAt)||this.now()-resource.sampledAt>30000||resource.sampledAt>this.now()+1000||
      !finite(resource.totalMemoryBytes)||resource.totalMemoryBytes<8*1024**3||
      !finite(resource.availableMemoryBytes)||resource.availableMemoryBytes<Math.max(2*1024**3,resource.totalMemoryBytes*.15))return base;
    this.hardwareAvailable=await this.media.liveHardwareAvailable?.()===true;
    // Native sampling and the first tiny encoder probe may take time. Admission
    // must use the writer/index state after those awaits, never the old snapshot.
    const fresh=await this.context();
    fresh.loopDelayMs=Math.max(base.loopDelayMs||0,fresh.loopDelayMs||0);
    return fresh;
  }
  close(){this.closed=true;this.monitor?.disable();this.monitor=null;this.progress.clear();this.backlog.clear();}
}
