export const hasRecording=(store,recorder)=>recorder.rooms.some(room=>room.recording)||!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('recording','waiting') LIMIT 1");
export const hasIndexing=store=>!!store.get("SELECT id FROM sessions WHERE deleted_at='' AND status IN ('importing','finishing') LIMIT 1");
const hasExportJobs=store=>!!store.get("SELECT id FROM jobs WHERE status IN ('queued','running','finalizing','saving','cancelling') LIMIT 1");

export function appActivity({store,media,recorder,preparation,storage,ingestor,deletingSessions}){
  const recording=hasRecording(store,recorder);
  const processing=media.hasForegroundWork({includeInteractive:false})||hasExportJobs(store);
  const preparing=!!preparation.active||!!store.get("SELECT session FROM preparation_jobs WHERE paused=0 AND status IN ('queued','preparing') LIMIT 1");
  const organising=ingestor.busy||storage.busy||deletingSessions.size>0||hasIndexing(store);
  const monitoring=recorder.hasEnabledFollowTargets||recorder.rooms.some(room=>room.recordingEnabled!==false&&(room.autoRecord||room.recordingEnabled===true));
  const busy=recording||processing||preparing||organising||!!recorder.starting||recorder.pollBusy;
  const exporting=media.processing||media.enqueues.size>0||media.saves.size>0||media.savePreparations.size>0||hasExportJobs(store);
  return {updateBusy:store.recovery.recovering||recording||processing||organising||!!preparation.active||media.fonts.changing||!!recorder.starting, busy:busy||store.recovery.recovering,background:busy||monitoring||store.recovery.recovering,requiresExitConfirmation:recording||exporting,reason:store.recovery.recovering?'任务恢复':recording?'录制':processing?'导出':preparing?'预处理':organising?'素材整理':monitoring?'监控':'',recorderPort:recorder.port};
}
