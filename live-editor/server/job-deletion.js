import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveFile, exportedJobFile } from './output-names.js';
import { directories } from './directories.js';

const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const same = (a, b) => key(a) === key(b);
function within(root, file) {
  const relative = path.relative(key(root), key(file));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('导出文件路径无效，未执行删除。');
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(value) || value.slice(2).includes(':') || value.split(/[\\/]/).some(part => /[. ]$/.test(part)))) throw new Error('导出文件路径不是普通本机磁盘路径，未执行删除。');
  return path.resolve(value);
}
function dataOf(job) {
  try { const data = JSON.parse(job.data || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch { throw new Error('导出任务的文件记录损坏，未执行删除。'); }
}
const recordSignature = job => JSON.stringify([job.id, job.session, job.status, job.mode, job.file, job.data]);
const identity = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs'].map(field => [field, String(stat[field])]));
const equalIdentity = (stat, receipt) => ['dev', 'ino', 'size', 'mtimeNs'].every(field => String(stat[field]) === receipt[field]);
function assertInactive(job) {
  if (!job) { const error = new Error('导出任务不存在或已经删除。'); error.status = 404; throw error; }
  if (['queued', 'running', 'finalizing', 'saving', 'cancelling'].includes(job.status)) throw new Error('导出任务仍在排队或处理中，请完成或取消后再删除。');
  if (job.status === 'save_failed') throw new Error('这次导出的成片尚未保存，请先重试保存，避免丢失已编码的视频。');
  if (!['done', 'failed', 'cancelled', 'canceled'].includes(job.status)) throw new Error('导出任务状态无效，未执行删除。');
}

// Only the exact recorded video(s) are
// owned. Never enumerate a folder: full exports share their date directory.
function ownedFiles(store, job) {
  const data = dataOf(job), output = data.output || {}, primary = job.file || '';
  if (!primary && !output.file && !output.danmakuFile) return [];
  const base = absolute(output.file || primary), directory = absolute(output.dir || path.dirname(base));
  if (!same(path.dirname(base), directory) || !/\.mp4$/i.test(base)) throw new Error('导出文件与任务所属目录不一致，未执行删除。');
  let root;
  if (data.outputRoot) root = absolute(data.outputRoot);
  else if (output.dir) root = directory;
  else root = [path.join(store.root, 'exports'), directories(store).exports].find(candidate => within(candidate, base));
  if (!root || !within(root, base)) throw new Error('无法确认导出文件属于这个任务的输出目录，未执行删除。');
  const mode = job.mode;
  if (!['clean', 'dual', 'danmaku'].includes(mode)) throw new Error('导出版本记录无效，未执行删除。');
  const effective = { ...job, mode }, files = [];
  const add = file => {
    file = absolute(file);
    if (!within(root, file) || !same(path.dirname(file), directory)) throw new Error('导出文件超出任务所属目录，未执行删除。');
    for (const folder of ['originals', 'archives', 'chunks', 'temp', 'profile', 'runtime']) {
      const protectedRoot = path.join(store.root, folder);
      if (same(protectedRoot, file) || within(protectedRoot, file)) throw new Error('该路径属于录制素材或程序内部文件，不能作为导出文件删除。');
    }
    if (!files.some(entry => same(entry.path, file))) files.push({ path: file, root });
  };
  const stem = path.parse(base).name.replace(/^(?:【弹幕版】)+/u, '').replace(/(?:_弹幕版)+$/u, '');
  const bakedNames = ['【弹幕版】' + stem + '.mp4'];
  if (primary) {
    const file = absolute(primary);
    if (mode === 'danmaku') {
      if (!bakedNames.includes(path.basename(file))) throw new Error('弹幕版路径与任务命名记录不一致，未执行删除。');
    } else if (!same(file, base)) throw new Error('导出视频路径与任务文件记录不一致，未执行删除。');
    add(file);
  } else if (mode !== 'danmaku') add(base);
  if (mode === 'dual' || mode === 'danmaku') {
    const baked = exportedJobFile(effective, 'danmaku');
    if (baked) {
      if (!bakedNames.includes(path.basename(baked))) throw new Error('弹幕版路径与任务命名记录不一致，未执行删除。');
      add(baked);
    }
  }
  return files;
}

async function inspect(file, root) {
  file = absolute(file);
  if (!within(root, file)) throw new Error('导出路径超出允许删除的目录。');
  const volume = path.parse(file).root; let current = volume, stat;
  for (const part of path.relative(volume, file).split(path.sep)) {
    current = path.join(current, part);
    try { stat = await fs.lstat(current, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error('导出路径含符号链接或目录联接，已停止删除。');
    if (!same(current, file) && !stat.isDirectory()) throw new Error('导出文件的父级不是普通目录，已停止删除。');
  }
  if (!stat.isFile()) throw new Error('导出路径不是普通文件，已停止删除。');
  if (stat.nlink > 1n) throw new Error('导出文件存在共享硬链接，已停止删除。');
  if (!same(await fs.realpath(file), file)) throw new Error('导出文件实际路径发生重定向，已停止删除。');
  return stat;
}

function references(store, id) {
  const found = new Map(), add = (file, reason) => {
    if (typeof file === 'string' && path.isAbsolute(file)) found.set(key(file), { file, reason });
  };
  for (const row of store.all('SELECT path,xml FROM sources')) { add(row.path, '原始录像仍在使用'); add(row.xml, '原始弹幕仍在使用'); }
  for (const row of store.all('SELECT path FROM chunks UNION SELECT path FROM compact_chunks')) add(row.path, '内部录制素材仍在使用');
  for (const row of store.all("SELECT archive FROM sessions WHERE archive!=''")) {
    add(row.archive, '整场原始归档仍在使用');
    for (const kind of ['xml', 'manifest']) add(archiveFile(row.archive, kind), '原始归档附属文件仍在使用');
  }
  for (const job of store.all('SELECT * FROM jobs WHERE id<>?', id)) {
    add(job.file, '其他导出任务仍在使用');
    for (const kind of ['danmaku']) add(exportedJobFile(job, kind), '其他导出任务仍在使用');
    let data; try { data = dataOf(job); } catch { continue; }
    add(data.output?.file, '其他导出任务仍在使用'); add(data.output?.danmakuFile, '其他导出任务仍在使用');
    if (Array.isArray(data.publishedFiles)) for (const file of data.publishedFiles) add(file?.path, '其他导出任务仍在使用');
  }
  return [...found.values()];
}
async function protectedPaths(store, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const entries = references(store, id), signature = JSON.stringify(entries), protectedFiles = new Map();
    for (let offset = 0; offset < entries.length; offset += 32) await Promise.all(entries.slice(offset, offset + 32).map(async entry => {
      protectedFiles.set(key(entry.file), entry.reason);
      try { protectedFiles.set(key(await fs.realpath(entry.file)), entry.reason); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }));
    if (signature === JSON.stringify(references(store, id))) return protectedFiles;
  }
  throw new Error('素材或导出文件引用刚发生变化，请稍后再试。');
}

export class JobDeletion {
  constructor(store) { this.store = store; this.previews = new Map(); this.deleting = new Set(); }
  job(id) { return this.store.get('SELECT * FROM jobs WHERE id=?', id); }
  assertCurrent(plan) {
    const current = this.job(plan.id); assertInactive(current);
    if (recordSignature(current) !== plan.signature) throw new Error('导出任务记录已变化，请重新确认文件后删除。');
  }
  async plan(id) {
    const job = this.job(id); assertInactive(job);
    const entries = ownedFiles(this.store, job), data = dataOf(job), receipts = data.publishedFiles;
    if (receipts !== undefined && (!Array.isArray(receipts) || receipts.some(receipt => !receipt || typeof receipt.path !== 'string' || ['dev', 'ino', 'size', 'mtimeNs'].some(field => typeof receipt[field] !== 'string' || !/^\d+$/.test(receipt[field]))))) throw new Error('导出文件发布凭证无效，未执行删除。');
    const protectedFiles = await protectedPaths(this.store, id), files = [], preserved = [];
    for (const entry of entries) {
      // Failed/cancelled attempts can name a destination now reserved by a
      // different job. Without a publication receipt they do not own it.
      if(job.status!=='done'&&!receipts?.some(receipt=>same(receipt.path,entry.path))&&protectedFiles.has(key(entry.path))) {
        preserved.push({path:entry.path,reason:protectedFiles.get(key(entry.path))});continue;
      }
      if (protectedFiles.has(key(entry.path))) throw new Error(`无法删除：${protectedFiles.get(key(entry.path))}（${entry.path}）。`);
      const stat = await inspect(entry.path, entry.root);
      if (stat) {
        const receipt = receipts?.find(receipt => same(receipt.path, entry.path));
        if (receipts !== undefined && (!receipt || !equalIdentity(stat, receipt))) throw new Error(`导出文件在发布后发生变化或不属于此任务，未执行删除：${entry.path}`);
        if (job.status !== 'done' && !receipt) throw new Error(`失败任务无法确认现存文件的所有权，请先检查文件：${entry.path}`);
      }
      files.push({ ...entry, exists: !!stat, size: stat ? Number(stat.size) : 0, identity: stat && identity(stat), ctimeNs: stat && String(stat.ctimeNs) });
    }
    const plan = { id, token: randomUUID(), signature: recordSignature(job), files, preserved };
    this.assertCurrent(plan); return plan;
  }
  async preview(id) {
    if (!this.job(id)) { const error = new Error('导出任务不存在或已经删除。'); error.status = 404; throw error; }
    try {
      if (this.deleting.has(id)) throw new Error('此导出任务正在删除，请稍候。');
      const plan = await this.plan(id);
      this.previews.delete(id); this.previews.set(id, plan);
      while (this.previews.size > 100) this.previews.delete(this.previews.keys().next().value);
      return { id, token: plan.token, files: plan.files.map(({ path, exists, size }) => ({ path, exists, size })), preserved:plan.preserved, blocked: false };
    } catch (error) {
      this.previews.delete(id);
      return { id, files: [], blocked: true, reason: error.message };
    }
  }
  async delete(id, input = {}) {
    if (input.confirmed !== true) throw new Error('请先确认是否删除导出文件和任务记录。');
    if (this.deleting.has(id)) throw new Error('此导出任务正在删除，请稍候。');
    this.deleting.add(id); let deletedFiles = 0, freedBytes = 0;
    try {
      assertInactive(this.job(id));
      // Explicit history-only removal has no dependency on path validation or
      // file access. Never fall back to it implicitly after an unlink failure.
      if (input.recordOnly === true) {
        this.store.transaction(() => {
          assertInactive(this.job(id));
          this.store.run('DELETE FROM jobs WHERE id=?', id);
        });
        this.previews.delete(id);
        return { ok: true, recordOnly: true, deletedFiles: 0, freedBytes: 0 };
      }
      const plan = this.previews.get(id);
      if (!plan || typeof input.token !== 'string' || input.token !== plan.token) { const error = new Error('请重新预览导出文件并确认后再删除。'); error.status = 409; throw error; }
      this.previews.set(id, plan); this.assertCurrent(plan);
      // Preflight all identities again before the first unlink. Missing files
      // are allowed; a new file at a previously missing path is never owned.
      const check = async entry => {
        const stat = await inspect(entry.path, entry.root);
        if (stat && (!entry.exists || !equalIdentity(stat, entry.identity) || String(stat.ctimeNs) !== entry.ctimeNs)) throw new Error(`文件在确认后发生变化，请重新检查：${entry.path}`);
        return stat;
      };
      for (const entry of plan.files) await check(entry);
      for (const entry of plan.files) {
        const protectedFiles = await protectedPaths(this.store, id);
        this.assertCurrent(plan);
        if (protectedFiles.has(key(entry.path))) throw new Error(`文件已被其他素材或任务引用，已停止删除：${entry.path}`);
        const stat = await check(entry);
        if (!stat) continue;
        this.assertCurrent(plan);
        try { await fs.unlink(entry.path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`无法删除文件，请关闭占用它的程序后重试：${entry.path}（${error.code || error.message}）`, { cause: error }); }
        deletedFiles++; freedBytes += Number(stat.size);
      }
      this.assertCurrent(plan);
      this.store.run('DELETE FROM jobs WHERE id=?', id);
      this.previews.delete(id);
      return { ok: true, deletedFiles, freedBytes };
    } catch (error) {
      if (deletedFiles) error.message = `已删除 ${deletedFiles} 个文件，其余文件和任务记录保留，可重试。${error.message}`;
      throw error;
    } finally { this.deleting.delete(id); }
  }
}
