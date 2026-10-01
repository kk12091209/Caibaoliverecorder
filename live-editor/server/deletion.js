import fs from 'node:fs/promises';
import path from 'node:path';
import { archiveFile, exportedJobFile } from './output-names.js';
import { deletionWork } from './deletion-work.js';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(root, file) {
  const relative = path.relative(key(root), key(file));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function absolute(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error('素材文件路径无效，未执行删除。');
  return path.resolve(file);
}

// Check every ancestor, including the data directory itself. Windows junctions
// are reported by lstat as symbolic links; realpath also rejects redirection.
async function checked(root, file, directory = false) {
  file = absolute(file);
  if (!inside(root, file)) throw new Error('素材路径超出本项目允许清理的目录，未执行删除。');
  const volume = path.parse(file).root;
  let current = volume, stat;
  for (const component of path.relative(volume, file).split(path.sep)) {
    current = path.join(current, component);
    try { stat = await fs.lstat(current, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error('素材路径包含符号链接或目录联接，已停止删除。');
    if (key(current) !== key(file) && !stat.isDirectory()) throw new Error('素材路径的父级不是普通目录，已停止删除。');
  }
  if (key(await fs.realpath(file)) !== key(file)) throw new Error('素材实际路径发生重定向，已停止删除。');
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('素材路径类型异常，已停止删除。');
  return stat;
}

export function assertDeletable(store, id) {
  const session = store.get('SELECT * FROM sessions WHERE id=?', id);
  if (!session || session.purged_at) throw new Error('素材不存在或已永久删除。');
  if (session.status !== 'finished' || store.get('SELECT id FROM sources WHERE session=? AND (closed IS NULL OR closed<>2)', id)) throw new Error('这份素材仍在录制或整理中，请结束后再删除。');
  if (session.archive_status === 'running' || store.get("SELECT id FROM jobs WHERE session=? AND status IN ('queued','running','finalizing','saving','cancelling')", id)) throw new Error('这份素材正在归档或导出，请完成后再删除。');
  if (store.get("SELECT id FROM jobs WHERE session=? AND status='save_failed'", id)) throw new Error('这份素材还有编码完成但尚未保存的导出，请先重试保存。');
  return session;
}

function archiveFiles(file) {
  const stem=path.join(path.dirname(file),path.parse(file).name);
  const files = [file, archiveFile(file, 'xml'), archiveFile(file, 'manifest'),stem+'.legacy.xml',stem+'.originals.ffconcat'];
  if (path.parse(file).name === 'full') files.push(path.join(path.dirname(file), 'full.xml'));
  return files;
}

function references(store, id) {
  const result = [], add = (file, reason) => { if (typeof file === 'string' && path.isAbsolute(file)) result.push({ file: path.resolve(file), reason }); };
  for (const source of store.all("SELECT sources.* FROM sources JOIN sessions ON sessions.id=sources.session WHERE sources.session<>? AND sessions.purged_at=''", id)) {
    add(source.path, '其他素材仍在使用'); add(source.xml, '其他素材仍在使用');
  }
  for (const chunk of store.all("SELECT chunks.path FROM chunks JOIN sources ON sources.id=chunks.source JOIN sessions ON sessions.id=sources.session WHERE sources.session<>? AND sessions.purged_at=''", id)) add(chunk.path, '其他素材仍在使用');
  for (const session of store.all("SELECT archive FROM sessions WHERE id<>? AND purged_at='' AND archive!=''", id)) for (const file of archiveFiles(session.archive)) add(file, '其他素材仍在使用');
  for (const job of store.all('SELECT file,mode,data FROM jobs')) {
    add(job.file, '已导出的视频'); add(exportedJobFile(job, 'danmaku'), '已导出的视频');
    let data; try { data = JSON.parse(job.data); } catch {}
    add(data?.output?.file, '已导出的视频'); add(data?.output?.danmakuFile, '已导出的视频');
  }
  return result;
}

async function protections(store, id, cache) {
  const signature = entries => JSON.stringify(entries.map(entry => [key(entry.file), entry.reason]));
  cache.resolved??=new Map();
  // Chat and progress updates do not change the actual reference signature.
  // Cache resolved paths within this deletion so an unrelated new recording
  // only requires checking its new files, not rescanning the entire library.
  for(let attempt=0;attempt<4;attempt++) {
    const revision=store.get('SELECT total_changes() AS n').n;
    if(cache.revision===revision)return cache.paths;
    const entries=references(store,id),current=signature(entries);
    if(cache.signature===current){cache.revision=revision;return cache.paths;}
    const paths=new Map();
    for(let offset=0;offset<entries.length;offset+=32) {
      await Promise.all(entries.slice(offset,offset+32).map(async entry=>{
        const name=key(entry.file);paths.set(name,entry.reason);
        let resolved=cache.resolved.get(name);
        if(!resolved) {
          try{resolved=key(await fs.realpath(entry.file));cache.resolved.set(name,resolved);}
          catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
        }
        if(resolved)paths.set(resolved,entry.reason);
      }));
    }
    const after=store.get('SELECT total_changes() AS n').n;
    if(after===revision||signature(references(store,id))===current){cache.revision=after;cache.signature=current;cache.paths=paths;return paths;}
  }
  throw new Error('素材文件引用正在变化，请稍后重试删除。');
}

export async function prepareDeletion(store, id, { control }={}) {
  control?.check();
  const session = assertDeletable(store, id), sources = store.sources(id);
  const chunks = store.all('SELECT chunks.* FROM chunks JOIN sources ON sources.id=chunks.source WHERE sources.session=? ORDER BY chunks.source,chunks.seq', id);
  const roots = { originals: path.join(store.root, 'originals'), chunks: path.join(store.root, 'chunks'), archives: path.join(store.root, 'archives') };
  const files = new Map(), directories = new Map(), preserved = new Map(), external = new Set();
  const preserve = (file, reason) => preserved.set(key(file), { path: file, reason });
  async function add(file, root) {
    control?.check();
    file = absolute(file);
    if (files.has(key(file))) return;
    const stat = await checked(root, file);
    control?.progress();
    // Missing files are already gone. Never delete replacements created after
    // this preflight; retries build a fresh, independently checked manifest.
    if (stat) files.set(key(file), { file, root, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs });
  }
  for (const source of sources) {
    control?.check();
    const original = absolute(source.path);
    if (inside(roots.originals, original)) {
      await add(original, roots.originals);
      // Recorder diagnostics use the exact FLV stem; never touch room config
      // files or unrelated logs in the same directory.
      if (/\.flv$/i.test(original)) await add(original.replace(/\.flv$/i, '.txt'), roots.originals);
      if (source.xml && key(source.xml) === key(original.replace(/\.flv$/i, '.xml')) && /\.flv$/i.test(original)) await add(source.xml, roots.originals);
      else if (source.xml) preserve(absolute(source.xml), '非本素材同名弹幕文件');
    } else {
      preserve(original, '外部导入的原文件'); external.add(key(original));
      if (source.xml) preserve(absolute(source.xml), '外部导入的弹幕文件');
    }
    if (!source.id || /[\\/\x00-\x1f]/.test(source.id) || ['.','..'].includes(source.id)) throw new Error('内部素材编号无效，未执行删除。');
    const folder = path.join(roots.chunks, source.id);
    const folderStat = await checked(roots.chunks, folder, true);
    if (folderStat) {
      directories.set(key(folder), { file: folder, root: roots.chunks, dev: folderStat.dev, ino: folderStat.ino });
      const names=(await fs.readdir(folder)).filter(name=>/^\d{8,}\.flvpart(?:\.tmp)?$/.test(name));
      await deletionWork(names,name=>add(path.join(folder,name),folder),8,{control});
    }
    for (const chunk of chunks.filter(chunk => chunk.source === source.id)) await add(chunk.path, folder);
  }
  if (session.archive) {
    const archive = absolute(session.archive);
    if (inside(roots.archives, archive) && /\.(?:flv|mkv|mp4)$/i.test(archive)) for (const file of archiveFiles(archive)) await add(file, roots.archives);
    else preserve(archive, '非本项目自动归档文件');
  }
  const protectionCache = {}, protectedPaths = await protections(store, id, protectionCache);
  control?.progress();
  const retainedPaths=new Map(preserved);
  for(const entry of preserved.values()) {
    try{retainedPaths.set(key(await fs.realpath(entry.path)),entry);}
    catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  }
  for (const [name, entry] of files) {
    if(retainedPaths.has(name)){preserve(entry.file,retainedPaths.get(name).reason);files.delete(name);continue;}
    if(protectedPaths.has(name)){preserve(entry.file,protectedPaths.get(name));files.delete(name);}
  }
  return { files: [...files.values()], directories: [...directories.values()], preserved, external, protectionCache,
    sourcesSnapshot: JSON.stringify(sources), chunksSnapshot: JSON.stringify(chunks), archive: session.archive };
}

export async function removeDeletionFiles(store, id, plan, { control }={}) {
  control?.check();
  let deletedFiles = 0, freedBytes = 0, pending = false;
  // Keep originals/companions ordered: a locked original must fail before its
  // XML or any transient chunks are removed. Only the large chunk set runs in
  // parallel, after these critical files have succeeded.
  const chunkRoot=path.join(store.root,'chunks');
  const groups=new Map();
  for(const entry of plan.files){
    if(!inside(chunkRoot,entry.file)){await remove(entry);continue;}
    const inode=String(entry.dev)+':'+String(entry.ino);if(!groups.has(inode))groups.set(inode,[]);groups.get(inode).push(entry);
  }
  await deletionWork([...groups.values()],async entries=>{for(const entry of entries)await remove(entry);},8,{control});
  async function remove(entry){
    control?.check();
    // Recheck sharing after async preflight and whenever this connection has
    // changed. A new import/export reference must never be silently deleted.
    const stat=await checked(entry.root,entry.file);
    const protectedPaths=await protections(store,id,plan.protectionCache);
    control?.progress();
    if (protectedPaths.has(key(entry.file))) { plan.preserved.set(key(entry.file), { path: entry.file, reason: protectedPaths.get(key(entry.file)) }); return; }
    if (!stat) return;
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size || stat.mtimeNs !== entry.mtimeNs) throw new Error('素材文件在删除前发生变化，已停止清理，请检查后重试。');
    try { await fs.unlink(entry.file); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error(`未能删除素材文件，可稍后重试：${entry.file}（${error.code || error.message}）`, { cause: error }); }
    deletedFiles++;
    control?.progress();
    // Count the last hard link only; old archives can share original FLV data.
    if (stat.nlink <= 1n) freedBytes += Number(stat.size);
  }
  for (const entry of plan.directories) {
    control?.check();
    const stat = await checked(entry.root, entry.file, true); if (!stat) continue;
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('内部片段目录在删除前发生变化，已停止清理。');
    control?.check();
    try { await fs.rmdir(entry.file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (['ENOTEMPTY','EEXIST'].includes(error.code)) {
        const protectedPaths=await protections(store,id,plan.protectionCache);
        if((await fs.readdir(entry.file)).some(name=>!protectedPaths.has(key(path.join(entry.file,name)))))pending=true;
        plan.preserved.set(key(entry.file), { path: entry.file, reason: '目录中仍有其他文件，已保留' }); continue;
      }
      throw error;
    }
    control?.progress();
  }
  const externalFilesPreserved = plan.external.size;
  return { deletedFiles, freedBytes, pending, externalFilesPreserved, preserved: [...plan.preserved.values()],
    message: externalFilesPreserved ? `素材缓存已删除；保留 ${externalFilesPreserved} 个外部导入的原文件和已导出视频。` : '素材及本项目缓存已永久删除，已导出视频保留。' };
}
