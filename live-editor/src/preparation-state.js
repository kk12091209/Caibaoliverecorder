import { ui } from '../shared/ui-copy.js';
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
  const recordingLabel = session.status === 'waiting' ? ui.common.等待重连 : ui.common.录制中;
  const waitingForTail = ['tail', 'metadata', 'warming-up', 'observing'].includes(current?.reason);
  const label = prepared > 0
    ? ui.preparation.提前处理进度(recordingLabel, formatVideoTime(prepared))
    : active ? ui.preparation.录制中正在提前处理
      : waitingForTail ? ui.preparation.录制中等待稳定片段
        : ui.preparation.优先保证录制稍后继续处理;
  const note = active
    ? ui.preparation.正在利用设备余量提前处理录制优先
    : waitingForTail ? ui.preparation.新录制的内容稳定后再自动提前处理
      : ui.preparation.录制优先处理说明;
  return { label, note, active };
}
