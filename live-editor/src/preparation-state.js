import { formatVideoTime } from './video-time.js';

// Live progress belongs to a specific recording. Never show another room's
// background activity as progress for the material currently being viewed.
export function livePreparationView(session, preparation, entry) {
  if (!session || !['recording', 'waiting'].includes(session.status)) return null;
  if (preparation?.liveEnabled !== true || preparation?.enabled === false) return null;
  const live = preparation.live;
  const current = live?.sessionId === session.id ? live : null;
  const prepared = entry?.session === session.id ? Math.max(0, Number(entry.preparedSeconds) || 0) : 0;
  const active = current?.active === true;
  const recordingLabel = session.status === 'waiting' ? '等待重连' : '录制中';
  const waitingForTail = ['tail', 'metadata', 'warming-up', 'observing'].includes(current?.reason);
  const label = prepared > 0
    ? `${recordingLabel} · 已提前处理 ${formatVideoTime(prepared)}`
    : active ? '录制中 · 正在提前处理'
      : waitingForTail ? '录制中 · 等待稳定片段'
        : '优先保证录制，稍后继续处理';
  const note = active
    ? '正在利用设备余量提前处理，录制优先。'
    : waitingForTail ? '新录制的内容稳定后，再自动提前处理。'
      : '优先保证录制，条件合适时自动继续；其余内容会在录制结束后处理。';
  return { label, note, active };
}
