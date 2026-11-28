import { ui } from '../shared/ui-copy.js';
// The editor persists start/stop intent separately from automatic recording.
export function roomAvailable(room, recorder) {
  if(room.platform==='xiaohongshu')return !!recorder.xiaohongshuOnline;
  return room.platform === 'douyin'
    ? !!recorder.douyinOnline
    : !!(recorder.biliOnline ?? recorder.online);
}
export function roomRecordEnabled(room) {
  return !!room.recording || (typeof room.recordingEnabled==='boolean'
    ? room.recordingEnabled : !!room.autoRecord && room.autoRecordForThisSession !== false);
}
export function roomStatus(room) {
  if(room.recordingEnabled!==false&&room.recordingHealth?.message)return room.recordingHealth.message;
  if (room.recording) return ui.roomStatus.正在录制;
  if (roomRecordEnabled(room)) return room.streaming ? ui.roomStatus.正在准备录制 : ui.roomStatus.监控中等待开播;
  return room.streaming ? ui.roomStatus.直播中已停止录制 : ui.common.已停止;
}

// Live status and capture status are independent: a verified broadcast may
// still be waiting for its first usable stream or for the recorder to start.
function hasRecordingOutput(anchor) {
  if (!anchor.recording || anchor.platform !== 'bilibili') return !!anchor.recording;
  if (typeof anchor.recordingHasOutput === 'boolean') return anchor.recordingHasOutput;
  // Older cores expose only counters. A missing counter cannot establish
  // zero output; retain their reported status when the sample is incomplete.
  const output = anchor.recordingStats?.totalOutputBytes;
  return !Number.isFinite(output) || output > 0 || anchor.ioStats?.diskBytesWritten > 0;
}

export function monitoredAnchorStatus(anchor) {
  const { enabled, streaming } = anchor;
  const recording = hasRecordingOutput(anchor);
  const copy = ui.anchors;
  if(anchor.policyPending){
    const label=copy.本场结束后移除;
    return {recording,label,detail:label,warning:''};
  }
  let detail = (enabled && anchor.recordingHealth?.message) ||
    (anchor.legacy ? roomStatus(anchor) : anchor.state || '');
  const idleFollow = anchor.platform === 'douyin' && !anchor.legacy &&
    enabled && !recording && !streaming && !anchor.webRid;
  if (idleFollow && /^待确认：(本人直播间未开播，连麦状态暂无法确认|状态接口未返回目标用户)$/.test(detail)) {
    detail = copy.监控中;
  }
  const recovering = /正在恢复|重试|正在重连/.test(detail);
  const limited = /上限/.test(detail);
  const uncertain = /待确认|疑似|失联/.test(detail);
  let label = enabled ? copy.监控中 : ui.common.已停止;
  if (!idleFollow) {
    if (recovering) label = copy.正在恢复录制;
    else if (limited) label = copy.已达时长上限;
    else if (enabled && streaming && !recording) label = copy.已开播等待录制;
    else if (uncertain) label = recording ? copy.录制中待确认 : copy.等待恢复;
    else if (recording) label = anchor.kind === 'guest' ? copy.连麦录制中 : copy.直播录制中;
  }
  const warning = anchor.error || anchor.chatError || (recovering || limited || uncertain ? detail : '');
  return { recording, label, detail: label === copy.已开播等待录制 ? anchor.error || label : detail, warning };
}
