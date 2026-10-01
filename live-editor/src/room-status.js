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
  if (room.recording) return '正在录制';
  if (roomRecordEnabled(room)) return room.streaming ? '正在准备录制' : '监控中 · 等待开播';
  return room.streaming ? '直播中 · 已停止录制' : '已停止';
}
