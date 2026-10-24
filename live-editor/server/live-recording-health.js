import {monitorEventLoopDelay} from 'node:perf_hooks';

const MiB=1024**2;
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
    const telemetry=room.platform==='douyin'?room.recordingProgress:{
      observedAt:room.recordingObservedAt,bytes:room.recordingStats?.totalOutputBytes,
      mediaMs:room.recordingStats?.sessionMaxTimestamp};
    if(!telemetry||!finite(telemetry.observedAt)||!finite(telemetry.bytes)||!finite(telemetry.mediaMs))return 'observing';
    const key=String(room.roomId),previous=this.progress.get(key);
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
  async context() {
    const at=this.now(),base={recordingCount:0,recordingState:'observing',recordingHealthy:false,
      recordingWriteHealthy:false,hardwareAvailable:this.hardwareAvailable===true,sourceReady:false,foreground:this.closed||!!this.blocked()};
    if(this.closed)return base;
    base.loopDelayMs=this.loopDelay();
    const sessions=this.store.all("SELECT id,room,status,error,duration FROM sessions WHERE deleted_at='' AND status IN ('recording','waiting')");
    const rooms=this.recorder.rooms.filter(room=>room.recording);
    base.recordingCount=Math.max(sessions.length,rooms.length);
    if(sessions.length!==1||rooms.length!==1)return base;
    const session=sessions[0],room=rooms[0];
    const matches=room.platform==='douyin' ? session.room===0&&this.store.setting('douyin-session:'+session.id)?.webRid===room.webRid
      : session.room>0&&(Number(room.roomId)===session.room||Number(room.shortId)===session.room);
    if(!matches)return base;
    base.sessionId=session.id;base.recordingIdentity=session.id;
    const sources=this.store.sources(session.id),open=sources.filter(source=>source.closed===0);
    if(session.status!=='recording'||session.error||room.error||room.recordingHealth||sources.some(source=>source.error)){
      base.recordingState='unhealthy';return base;
    }
    if(open.length!==1)return base;
    const source=open[0],state=this.recordingProgress(room,source.id,at);
    base.recordingState=state;base.recordingHealthy=state==='healthy';
    const ingest=this.ingestor.healthSnapshot?.(source.id);
    if(!ingest||!finite(ingest.observedAt)||ingest.observedAt>at+1000||at-ingest.observedAt>8000){
      base.recordingState=ingest?'unhealthy':'observing';base.recordingHealthy=false;return base;
    }
    if(!finite(ingest.unreadBytes)||!finite(ingest.writeLatencyMs)){base.recordingState='observing';base.recordingHealthy=false;return base;}
    const pending=ingest.unreadBytes>MiB;
    if(pending&&!this.backlog.has(source.id))this.backlog.set(source.id,at);
    if(!pending)this.backlog.delete(source.id);
    while(this.backlog.size>64)this.backlog.delete(this.backlog.keys().next().value);
    base.ingestLagMs=pending?Math.max(0,at-this.backlog.get(source.id)):0;
    const writer=room.platform==='douyin'?room.recordingProgress:null;
    const writeHealthy=finite(ingest.writeLatencyMs)&&ingest.writeLatencyMs<=500&&
      (!finite(ingest.inFlightWriteSince)||at-ingest.inFlightWriteSince<=500)&&
      (!writer||(finite(writer.writeLatencyMs)&&writer.writeLatencyMs<=500&&
        (!finite(writer.inFlightWriteSince)||at-writer.inFlightWriteSince<=500)));
    base.recordingWriteHealthy=writeHealthy;
    let header;try{header=JSON.parse(source.header);}catch{}
    base.sourceReady=source.duration>=150&&!!header?.video&&!!header?.audio;
    if(!base.recordingHealthy||!writeHealthy||base.foreground||base.ingestLagMs>15000||base.loopDelayMs>250||this.platform!=='darwin')return base;
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
