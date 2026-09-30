import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function directories(store) {
  const configured=store.setting('export-directory');
  const exports=configured||path.join(store.projectRoot||path.dirname(store.root),'导出视频默认路径');
  return {exports,full:path.join(exports,'完整素材'),clips:path.join(exports,'导出片段'),originals:path.join(store.root,'originals')};
}
export function exportScopeDirectory(root,scope='clips') { return path.join(root,scope==='full'?'完整素材':'导出片段'); }
export async function writableDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()) || /[\x00-\x1f]/.test(value)) throw new Error('请填写导出文件夹的完整路径。');
  const directory = path.resolve(value.trim());
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(directory)) throw new Error('请选择本机磁盘上的文件夹。');
  await fs.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.recorder-write-check-${randomUUID()}`);
  try { await fs.writeFile(probe, '', { flag: 'wx' }); await fs.unlink(probe); }
  catch { throw new Error('无法写入该文件夹，请选择有写入权限的位置。'); }
  return directory;
}
export function directoryToOpen(store, input) {
  let directory;
  if (input.jobId) {
    const job = store.get("SELECT file FROM jobs WHERE id=? AND status='done'", String(input.jobId));
    if (!job?.file) throw new Error('导出尚未完成。');
    directory = path.dirname(job.file);
  } else if (input.sessionId) {
    const session = store.session(String(input.sessionId));
    if(!session)throw new Error('素材不存在或已删除。');
    const job=store.get("SELECT file FROM jobs WHERE session=? AND status='done' AND CASE WHEN json_valid(data) THEN json_extract(data,'$.scope') END='full' AND file!='' ORDER BY created DESC,rowid DESC LIMIT 1",session.id);
    directory=job?.file?path.dirname(job.file):directories(store).full;
  } else directory = directories(store)[input.kind];
  if (!directory) throw new Error('未找到可打开的保存目录。');
  return directory;
}
export async function openDirectory(store, input) {
  const directory=directoryToOpen(store,input);
  await fs.mkdir(directory, { recursive: true });
  if (process.platform !== 'win32') throw new Error('打开文件夹功能仅支持 Windows。');
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [directory], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  return directory;
}
