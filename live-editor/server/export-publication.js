import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clipFile } from './output-names.js';

const MANIFEST = '.bili-export-publication.json';
const OWNER = '.bili-temp-owner.json';
const FORMAT = 'bili-export-publication-v1';
const ID = /^[\w-]{1,100}$/;
const DIRECTORY = /^bili-export-[A-Za-z0-9_-]+$/;
const fields = ['dev', 'ino', 'size', 'mtimeNs'];
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => key(a) === key(b);
const identity = stat => Object.fromEntries(fields.map(field => [field, String(stat[field])]));
const matches = (stat, value) => fields.every(field => String(stat[field]) === value[field]);
function inside(root, file) {
  const relative = path.relative(key(root), key(file));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function absolute(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw failure('INVALID_PATH', '保存路径必须是完整的本机文件路径。');
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(file) || file.slice(2).includes(':') || file.split(/[\\/]/).some(part => /[. ]$/.test(part)))) throw failure('INVALID_PATH', '保存路径包含不支持的磁盘或文件名。');
  return path.resolve(file);
}
function failure(code, message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }
function pending(error, directory) { error.savePending = true; error.directory = directory; return error; }

// Check each ancestor. Recreate only ordinary missing directories, never follow
// a symlink/junction into a different location while restoring an output path.
async function directory(file, create = false) {
  file = absolute(file); const volume = path.parse(file).root; let current = volume;
  for (const component of path.relative(volume, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', '保存路径包含链接或不是普通目录，已保留待保存的视频。');
  }
  if (!same(await fs.realpath(file), file)) throw failure('UNSAFE_PATH', '保存目录实际位置发生变化，已停止保存。');
  return file;
}
async function plainFile(file, { missing = false } = {}) {
  await directory(path.dirname(file)); let stat;
  try { stat = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', '视频文件包含链接或类型异常，未操作该文件。');
  return stat;
}
async function mp4Complete(file, size) {
  const handle = await fs.open(file, 'r');
  try {
    let position = 0, count = 0; const seen = new Set();
    while (position < size) {
      if (++count > 100000 || size - position < 8) throw failure('SOURCE_INVALID', '已编码视频的文件结构不完整，已保留现场。');
      const header = Buffer.alloc(16), { bytesRead } = await handle.read(header, 0, Math.min(16, size - position), position);
      if (bytesRead < 8) throw failure('SOURCE_INVALID', '已编码视频读取不完整，已保留现场。');
      let length = header.readUInt32BE(0); const type = header.toString('ascii', 4, 8);
      let minimum = 8;
      if (length === 1) { if (bytesRead < 16) throw failure('SOURCE_INVALID', '已编码视频头不完整。'); const large = header.readBigUInt64BE(8); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('SOURCE_INVALID', '视频文件长度无效。'); length = Number(large); minimum = 16; }
      else if (length === 0) length = size - position;
      if (length < minimum || length > size - position) throw failure('SOURCE_INVALID', '已编码视频长度与文件结构不一致，已保留现场。');
      seen.add(type); position += length;
    }
    if (!['ftyp', 'moov', 'mdat'].every(type => seen.has(type))) throw failure('SOURCE_INVALID', '未找到完整 MP4 成片结构，已保留现场。');
  } finally { await handle.close(); }
}
function resultPaths(manifest, override = {}) {
  const outputRoot = absolute(override.outputRoot ?? manifest.outputRoot), output = override.output ?? manifest.output;
  if (!output || typeof output !== 'object') throw failure('INVALID_PATH', '导出目标记录无效。');
  const base = absolute(output.file), dir = absolute(output.dir || path.dirname(base));
  if (!inside(outputRoot, base) || !same(path.dirname(base), dir) || !/\.mp4$/i.test(base)) throw failure('INVALID_PATH', '导出视频不在指定输出目录内。');
  const paths = manifest.files.map(file => ({ ...file, path: absolute(file.kind === 'danmaku' ? (output.danmakuFile || clipFile(base, 'danmaku')) : base) }));
  if (new Set(paths.map(file => key(file.path))).size !== paths.length || paths.some(file => !same(path.dirname(file.path), dir) || !inside(outputRoot, file.path) || !/\.mp4$/i.test(file.path))) throw failure('INVALID_PATH', '导出视频目标重复或越出指定目录。');
  return { outputRoot, output, paths };
}
function safeReceipt(value) { return value && typeof value.path === 'string' && ['link', 'copy'].includes(value.method) && ['final.mp4', 'final-danmaku.mp4'].includes(value.temporary) && fields.every(field => typeof value[field] === 'string' && /^\d+$/.test(value[field])); }
const publicReceipt = value => ({ path: value.path, ...Object.fromEntries(fields.map(field => [field, value[field]])) });

export class ExportPublication {
  constructor(temporaryWorkspaces) { this.temporary = temporaryWorkspaces; this.root = temporaryWorkspaces.root; this.busy = new Set(); }
  async checkDirectory(workDir) {
    workDir = absolute(workDir);
    if (!same(path.dirname(workDir), this.root) || !DIRECTORY.test(path.basename(workDir))) throw failure('INVALID_PATH', '待保存视频不在本程序的导出工作目录内。');
    await directory(workDir); return workDir;
  }
  async read(workDir, jobId) {
    await this.checkDirectory(workDir);
    const file = path.join(workDir, MANIFEST), stat = await plainFile(file);
    if (stat.nlink !== 1n || stat.size > 65536n) throw failure('INVALID_MANIFEST', '待保存记录无效，已保留视频。');
    const ownerStat = await plainFile(path.join(workDir, OWNER));
    if (ownerStat.nlink !== 1n || ownerStat.size > 16384n) throw failure('INVALID_MANIFEST', '待保存目录归属记录无效。');
    let manifest, owner;
    try { manifest = JSON.parse(await fs.readFile(file, 'utf8')); owner = JSON.parse(await fs.readFile(path.join(workDir, OWNER), 'utf8')); }
    catch (error) { throw failure('INVALID_MANIFEST', '待保存记录无法读取，已保留视频。', error); }
    if (manifest.format !== FORMAT || manifest.jobId !== jobId || !ID.test(jobId) || manifest.directory !== path.basename(workDir) || manifest.token !== owner.token || owner.retained?.jobId !== jobId || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2 || !Array.isArray(manifest.publishedFiles)) throw failure('INVALID_MANIFEST', '待保存记录与导出任务不一致，已保留视频。');
    if (manifest.files.some(file => !file || !['final.mp4', 'final-danmaku.mp4'].includes(file.temporary) || !['video', 'danmaku'].includes(file.kind) || fields.some(field => typeof file[field] !== 'string' || !/^\d+$/.test(file[field]))) || new Set(manifest.files.map(file => file.temporary)).size !== manifest.files.length || manifest.publishedFiles.some(file => !safeReceipt(file))) throw failure('INVALID_MANIFEST', '待保存文件清单无效，未操作文件。');
    const targets = resultPaths(manifest).paths;
    if (manifest.publishedFiles.length > manifest.files.length || new Set(manifest.publishedFiles.map(file => key(file.path))).size !== manifest.publishedFiles.length || manifest.publishedFiles.some(receipt => !targets.some(file => file.temporary === receipt.temporary && same(file.path, absolute(receipt.path)) && file.size === receipt.size && (receipt.method !== 'link' || fields.every(field => file[field] === receipt[field]))))) throw failure('INVALID_MANIFEST', '发布凭证超出待保存结果清单，未操作文件。');
    return manifest;
  }
  async write(workDir, manifest) {
    await this.checkDirectory(workDir);
    const owner = JSON.parse(await fs.readFile(path.join(workDir, OWNER), 'utf8'));
    if (owner.token !== manifest.token || owner.retained?.jobId !== manifest.jobId || owner.ownerPid !== process.pid) throw failure('INVALID_MANIFEST', '待保存目录的归属发生变化。');
    const target = path.join(workDir, MANIFEST);
    try { const stat = await plainFile(target); if (stat.nlink !== 1n) throw failure('UNSAFE_PATH', '待保存记录存在共享链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(workDir, `.bili-export-publication-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, target); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  async exclusive(workDir, operation) {
    const name = key(workDir);
    if (this.busy.has(name)) throw pending(failure('SAVE_BUSY', '这个视频正在保存，请等待完成。'), workDir);
    this.busy.add(name); try { return await operation(); } finally { this.busy.delete(name); }
  }
  async stage(job, workDir, results) {
    return this.exclusive(workDir, async () => {
      await this.checkDirectory(workDir);
      try {
        await fs.access(path.join(workDir, MANIFEST));
        const existing = await this.read(workDir, job.id);
        return { directory: workDir, jobId: job.id, state: existing.state };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!ID.test(job.id || '') || !['clean', 'danmaku', 'dual', undefined].includes(job.mode) || !Array.isArray(results) || !results.length || results.length > 2) throw failure('INVALID_MANIFEST', '待保存任务或成片列表无效。');
      const files = [];
      for (const result of results) {
        if (!['final.mp4', 'final-danmaku.mp4'].includes(result.temporary) || files.some(file => file.temporary === result.temporary)) throw failure('INVALID_MANIFEST', '待保存成片名称无效。');
        const source = path.join(workDir, result.temporary); let stat;
        try { stat = await plainFile(source); } catch (error) { if (error.code === 'ENOENT') throw failure('SOURCE_MISSING', `已编码的临时视频不存在：${source}`, error); throw error; }
        if (stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('SOURCE_INVALID', '已编码视频为空、长度异常或被共享，未开始保存。');
        await mp4Complete(source, Number(stat.size));
        const handle = await fs.open(source, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        const after = await plainFile(source); if (!matches(after, identity(stat)) || after.nlink !== 1n) throw failure('SOURCE_CHANGED', '已编码视频在校验期间发生变化，已停止保存。');
        files.push({ temporary: result.temporary, kind: job.mode === 'danmaku' || result.temporary === 'final-danmaku.mp4' ? 'danmaku' : 'video', ...identity(stat) });
      }
      const manifest = { format: FORMAT, jobId: job.id, session: job.session, directory: path.basename(workDir), mode: job.mode, scope: job.scope || 'clips', outputRoot: job.outputRoot, output: job.output, files, publishedFiles: [], state: 'ready', created: new Date().toISOString() };
      const targets = resultPaths(manifest);
      if (results.some((result, index) => !same(absolute(result.file), targets.paths[index].path))) throw failure('INVALID_PATH', '成片输出路径与任务记录不一致。');
      await this.temporary.retain(workDir, job.id);
      try {
        manifest.token = JSON.parse(await fs.readFile(path.join(workDir, OWNER), 'utf8')).token;
        await this.write(workDir, manifest);
      } catch (error) { throw pending(error, workDir); }
      return { directory: workDir, jobId: job.id, state: manifest.state };
    });
  }
  async discover(jobId) {
    if (!ID.test(jobId || '')) throw failure('INVALID_MANIFEST', '导出任务编号无效。');
    let names; try { names = await fs.readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const found = [];
    for (const name of names.filter(name => DIRECTORY.test(name))) {
      const workDir = path.join(this.root, name);
      try { const manifest = await this.read(workDir, jobId); found.push({ directory: workDir, jobId, state: manifest.state, created: manifest.created }); }
      catch (error) { if (!['ENOENT', 'INVALID_MANIFEST', 'UNSAFE_PATH'].includes(error.code)) throw error; }
    }
    if (found.length > 1) throw failure('AMBIGUOUS_RESULT', '同一任务存在多份待保存结果，请保留文件并检查。');
    return found[0] || null;
  }
  async existing(receipt) {
    let stat;
    try { stat = await plainFile(absolute(receipt.path), { missing: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat) return null;
    if (!matches(stat, receipt) || stat.nlink > (receipt.method === 'link' ? 2n : 1n)) throw failure('DESTINATION_CHANGED', `已保存文件发生变化，未操作该文件：${receipt.path}`);
    return stat;
  }
  async rollback(workDir, manifest) {
    const retained = [];
    for (const receipt of manifest.publishedFiles) {
      try {
        if (await this.existing(receipt)) {
          const encoded = manifest.files.find(file => file.temporary === receipt.temporary);
          const source = await plainFile(path.join(workDir, receipt.temporary), { missing: true });
          // A commit may already have removed this source before a crash.
          // Never roll back the only remaining verified copy of a video.
          if (!source || !encoded || !matches(source, encoded)) { retained.push(receipt); continue; }
          await fs.unlink(receipt.path);
        }
      }
      catch { retained.push(receipt); }
    }
    manifest.publishedFiles = retained;
  }
  async recoverLinks(workDir, manifest) {
    if (!['saving', 'failed'].includes(manifest.state)) return;
    let recovered = false;
    for (const file of resultPaths(manifest).paths) {
      if (manifest.publishedFiles.some(receipt => receipt.temporary === file.temporary)) continue;
      let source, target;
      try {
        source = await plainFile(path.join(workDir, file.temporary), { missing: true });
        target = await plainFile(file.path, { missing: true });
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // The durable saving intent plus identical inode proves this exact
      // hardlink. A copied or unrelated same-name file is never claimed.
      if (source && target && source.nlink === 2n && target.nlink === 2n && matches(source, file) && matches(target, file)) {
        manifest.publishedFiles.push({ path: file.path, temporary: file.temporary, method: 'link', ...identity(target) }); recovered = true;
      }
    }
    if (recovered) await this.write(workDir, manifest);
  }
  async publish(jobId, workDir, override = {}) {
    return this.exclusive(workDir, async () => {
      let manifest, claimed = false;
      try {
        manifest = await this.read(workDir, jobId); await this.temporary.adoptRetained(workDir, jobId); claimed = true;
        await this.recoverLinks(workDir, manifest);
        const targets = resultPaths(manifest, override);
        const sameTargets = manifest.publishedFiles.length === targets.paths.length && targets.paths.every(file => manifest.publishedFiles.some(receipt => same(receipt.path, file.path) && receipt.temporary === file.temporary));
        if (sameTargets && (await Promise.all(manifest.publishedFiles.map(receipt => this.existing(receipt)))).every(Boolean)) {
          manifest.state = 'published'; await this.write(workDir, manifest);
          return { directory: workDir, file: targets.paths[0].path, publishedFiles: manifest.publishedFiles.map(publicReceipt) };
        }
        await this.rollback(workDir, manifest);
        if (manifest.publishedFiles.length) throw failure('DESTINATION_CHANGED', '部分已保存文件已被更改或仍被占用，保留视频和记录，请检查后重试。');
        for (const file of manifest.files) {
          const source = path.join(workDir, file.temporary); let stat;
          try { stat = await plainFile(source); } catch (error) { if (error.code === 'ENOENT') throw failure('SOURCE_MISSING', `待保存的已编码视频不存在：${source}`, error); throw error; }
          if (!matches(stat, file) || stat.nlink !== 1n || stat.size <= 0n) throw failure('SOURCE_CHANGED', '待保存的视频已被更改或共享，已停止保存。');
        }
        manifest.outputRoot = targets.outputRoot; manifest.output = targets.output; manifest.state = 'saving'; delete manifest.lastError;
        await this.write(workDir, manifest);
        try { await directory(path.dirname(targets.paths[0].path), true); }
        catch (error) { throw this.destinationError(error, path.dirname(targets.paths[0].path)); }
        for (const file of targets.paths) {
          const source = path.join(workDir, file.temporary); let method = 'link';
          try {
            try { await fs.link(source, file.path); }
            catch (error) {
              if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error;
              method = 'copy'; await fs.copyFile(source, file.path, constants.COPYFILE_EXCL);
            }
          } catch (error) {
            if (error.code === 'ENOENT') {
              try { await plainFile(source); } catch (sourceError) { if (sourceError.code === 'ENOENT') throw failure('SOURCE_MISSING', `待保存的已编码视频不再存在：${source}`, sourceError); throw sourceError; }
            }
            throw this.destinationError(error, file.path);
          }
          const currentSource = await plainFile(source);
          if (!matches(currentSource, file) || currentSource.nlink !== (method === 'link' ? 2n : 1n)) throw failure('SOURCE_CHANGED', '临时视频在保存过程中发生变化，已停止保存。');
          const stat = await plainFile(file.path);
          if (stat.size !== BigInt(file.size) || stat.nlink !== (method === 'link' ? 2n : 1n)) throw failure('DESTINATION_CHANGED', '成片在保存期间发生变化，已保留原始编码结果。');
          if (method === 'link' && !matches(stat, file)) throw failure('DESTINATION_CHANGED', '新建成片链接与临时视频身份不一致。');
          const handle = await fs.open(file.path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          manifest.publishedFiles.push({ path: file.path, temporary: file.temporary, method, ...identity(stat) });
          await this.write(workDir, manifest);
        }
        manifest.state = 'published'; await this.write(workDir, manifest);
        return { directory: workDir, file: targets.paths[0].path, publishedFiles: manifest.publishedFiles.map(publicReceipt) };
      } catch (error) {
        if (manifest && claimed) {
          await this.rollback(workDir, manifest);
          manifest.state = 'failed'; manifest.lastError = { code: error.code || 'SAVE_FAILED', message: error.message, at: new Date().toISOString() };
          await this.write(workDir, manifest).catch(() => {});
        }
        throw pending(error, workDir);
      }
    });
  }
  destinationError(error, destination) {
    if (error.code === 'EEXIST') return failure('EEXIST', `保存位置已存在同名文件，请换名称或目录后重试：${destination}`, error);
    if (['ENOSPC', 'EDQUOT'].includes(error.code)) return failure('NO_SPACE', '目标磁盘空间不足，已编码的视频已保留；可更换保存目录重试。', error);
    if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error.code)) return failure('DESTINATION_UNAVAILABLE', `目标目录无法写入或已被移走，已编码的视频已保留：${destination}`, error);
    return error;
  }
  async verifyPublished(job) {
    try {
      const files = job.mode === 'dual'
        ? [{ kind: 'video' }, { kind: 'danmaku' }]
        : [{ kind: job.mode === 'danmaku' ? 'danmaku' : 'video' }];
      if (!['clean', 'dual', 'danmaku'].includes(job.mode) || !Array.isArray(job.publishedFiles) || job.publishedFiles.length !== files.length) return false;
      const expected = resultPaths({ outputRoot: job.outputRoot, output: job.output, files }).paths;
      if (new Set(job.publishedFiles.map(receipt => key(absolute(receipt.path)))).size !== files.length) return false;
      for (const target of expected) {
        const receipt = job.publishedFiles.find(receipt => same(absolute(receipt.path), target.path));
        if (!receipt || fields.some(field => typeof receipt[field] !== 'string' || !/^\d+$/.test(receipt[field]))) return false;
        const stat = await plainFile(target.path, { missing: true });
        if (!stat || stat.nlink !== 1n || stat.size <= 0n || !matches(stat, receipt)) return false;
      }
      return true;
    } catch { return false; }
  }
  async commit(jobId, workDir, publishedFiles) {
    return this.exclusive(workDir, async () => {
      try {
        const manifest = await this.read(workDir, jobId); await this.temporary.adoptRetained(workDir, jobId);
        if (manifest.state !== 'published' || !Array.isArray(publishedFiles) || publishedFiles.length !== manifest.files.length || manifest.publishedFiles.length !== manifest.files.length || manifest.publishedFiles.some(receipt => !publishedFiles.some(saved => saved && same(saved.path, receipt.path) && fields.every(field => saved[field] === receipt[field])))) throw failure('INVALID_RECEIPT', '成片发布凭证尚未完整保存，继续保留待保存视频。');
        for (const receipt of manifest.publishedFiles) if (!await this.existing(receipt)) throw failure('DESTINATION_MISSING', '已经保存的成片不再存在，继续保留临时视频。');
        for (const file of manifest.files) {
          const source = path.join(workDir, file.temporary), stat = await plainFile(source, { missing: true });
          if (!stat) continue;
          const receipt = manifest.publishedFiles.find(receipt => receipt.temporary === file.temporary);
          if (!matches(stat, file) || stat.nlink !== (receipt.method === 'link' ? 2n : 1n)) throw failure('SOURCE_CHANGED', '已编码文件身份发生变化，未清理它。');
          await fs.unlink(source);
        }
        for (const receipt of manifest.publishedFiles) { const stat = await this.existing(receipt); if (!stat || stat.nlink !== 1n) throw failure('DESTINATION_CHANGED', '成片文件状态变化，保留剩余记录。'); }
        await this.temporary.release(workDir, jobId); const cleaned = await this.temporary.finish(workDir);
        return { cleaned };
      } catch (error) { throw pending(error, workDir); }
    });
  }
}