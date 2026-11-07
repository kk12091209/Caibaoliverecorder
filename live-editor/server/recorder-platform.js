// Platform adapters supply room and anchor snapshots, input resolution, and
// room and anchor actions. Lifecycle order stays in the coordinator because
// the independently owned Bilibili core has different exit semantics.
export function roomAnchor(room, key) {
  return {
    ...room,
    key,
    enabled: room.recordingEnabled ?? (room.autoRecord && room.autoRecordForThisSession !== false),
    ownWebRid: String(room.webRid || room.roomId),
    legacy: true,
    history: [],
  };
}
