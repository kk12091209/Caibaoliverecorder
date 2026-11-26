import { ui } from '../shared/ui-copy.js';
import { publicationTagError } from '../shared/publication-tags.js';

const copy = ui.autoPost;
export const publicationModes = [
  { id: 'danmaku', label: copy.仅弹幕版 },
  { id: 'clean', label: copy.仅纯净版 },
  { id: 'dual', label: copy.双版本分P },
];

export function publicationAccountLabel(account) {
  if (!account?.uid) return '';
  return account.name ? `${account.name}（UID ${account.uid}）` : `UID ${account.uid}`;
}

export function preventImplicitPublication(event) {
  if (event.target instanceof HTMLInputElement) event.preventDefault();
}

export function publicationValidation({ title, tags, copyright, source }, required = true) {
  const tagError = publicationTagError(tags, { required, legacy: !required });
  if (tagError) return tagError;
  if (!required) return '';
  if ([...title].length > 80) return copy.标题过长;
  if (![1, 2].includes(copyright)) return copy.选择投稿类型;
  if (copyright === 2 && !source.trim()) return copy.请填转载来源;
  if (copyright === 2 && source.trim().length > 200) return copy.转载来源过长;
  return '';
}

export function publicationTransferLabel(transfer) {
  const rate = bytes => (bytes / 1048576).toFixed(2) + ' MiB/s';
  if (!transfer) return '';
  const part = transfer.part ? `P${transfer.part}/${transfer.parts}` : '';
  if (transfer.state === 'paused') return [part, '上传已让位', transfer.reason].filter(Boolean).join(' · ');
  const state = { idle: '全速上传', healthy: '录制中，自适应上传', observing: '观察录制写入',
    pressure: '正在保护录制' }[transfer.state];
  return [part, state, transfer.reason, rate(transfer.bytesPerSecond || 0),
    transfer.limitBytesPerSecond ? '上限 ' + rate(transfer.limitBytesPerSecond) : ''].filter(Boolean).join(' · ');
}

export function publicationStatus(status) {
  return ({
    queued: copy.等待导出,
    'waiting-source': copy.等待录制收尾,
    'waiting-media': copy.等待媒体任务,
    'waiting-upload': copy.等待上传,
    'waiting-idle': copy.等待系统空闲,
    'waiting-preparation': copy.等待自动预处理,
    preparing: copy.正在自动预处理,
    exporting: copy.正在导出,
    simulated: copy.还未提交,
    submitting: copy.正在提交,
    uploading: copy.上传中,
    submitted: copy.已提交,
    uncertain: copy.结果待确认,
    failed: copy.失败,
    blocked: copy.已暂停,
    cancelled: copy.已取消,
  })[status] || copy.还未提交;
}
