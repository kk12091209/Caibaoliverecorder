import { ui } from '../shared/ui-copy.js';
// The editor persists start/stop intent separately from automatic recording.
export function roomAvailable(room, recorder) {
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
