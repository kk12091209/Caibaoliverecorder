// The core keeps autoRecord (future broadcasts) separate from the user's
// start/stop choice for this broadcast. Waiting rooms can therefore be armed.
export function roomRecordEnabled(room) {
  return !!room.recording || (!!room.autoRecord && room.autoRecordForThisSession !== false);
}
export function roomStatus(room) {
  if (room.recording) return '正在录制';
  if (roomRecordEnabled(room)) return room.streaming ? '正在准备录制' : '监控中 · 等待开播';
  return room.streaming ? '直播中 · 已停止录制' : '已停止';
}
