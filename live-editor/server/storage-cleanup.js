import fs from 'node:fs/promises';
import path from 'node:path';
import { checkedFile, pathKey } from './storage-files.js';

function within(directory, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(pathKey(directory), pathKey(file));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function temporaryCleanupOptions(store) {
  if (!store.db) return {};
  store.db.exec(`CREATE TABLE IF NOT EXISTS temporary_cleanup_plans(directory TEXT PRIMARY KEY, plan TEXT NOT NULL)`);
  return {
    storageIdentity: store.cleanupStorage.join(':'),
    journal: {
      get: directory => {
        const row = store.get('SELECT plan FROM temporary_cleanup_plans WHERE directory=?', directory);
        return row ? JSON.parse(row.plan) : undefined;
      },
      set: (directory, plan) => store.run('INSERT INTO temporary_cleanup_plans VALUES(?,?)', directory, JSON.stringify(plan)),
      delete: directory => store.run('DELETE FROM temporary_cleanup_plans WHERE directory=?', directory),
    },
    isReferenced(directory, deletingSession) {
      const fileInside = file => within(directory, file);
      const prefix = pathKey(directory) + path.sep;
      // Check persisted references before deleting from an old workspace.
      // Include job data even when its recording has already been removed.
      const found = store.get(`SELECT 1 FROM sources WHERE substr(path,1,?)=? COLLATE NOCASE
        OR substr(xml,1,?)=? COLLATE NOCASE UNION ALL
        SELECT 1 FROM sessions WHERE substr(archive,1,?)=? COLLATE NOCASE LIMIT 1`,
        prefix.length,prefix,prefix.length,prefix,prefix.length,prefix);
      if (found) return true;
      for (const row of store.all("SELECT id,session,status,file,data FROM jobs WHERE file!='' OR data LIKE '%bili-%'")) {
        if (fileInside(row.file)) return true;
        let job;
        try { job = JSON.parse(row.data); } catch { continue; }
        if (fileInside(job?.pendingPublication?.directory) ||
            (row.session !== deletingSession || !deletingSession || row.status !== 'failed' && row.status !== 'interrupted') &&
              fileInside(job?.processingRecovery?.directory) ||
            fileInside(job?.output?.file) || fileInside(job?.output?.danmakuFile) ||
            Array.isArray(job?.publishedFiles) && job.publishedFiles.some(file => fileInside(file?.path))) return true;
      }
      return false;
    },
  };
}

const categories = [
  ['originals', 'originals'], ['chunks', 'chunks'], ['cache', 'render-cache/v1'], ['temporary', 'temp'],
];

async function directoryUsage(root, directory, seen) {
  const queue = [directory];
  let bytes = 0, incomplete = false;
  while (queue.length) {
    const folder = queue.pop();
    try {
      if (!await checkedFile(root, folder, { directory: true, missing: true })) continue;
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) queue.push(file);
        else if (entry.isFile()) {
          try {
            const stat = await checkedFile(root, file, { missing: true });
            if (!stat) continue;
            if (stat.nlink > 1n) {
              const identity = `${stat.dev}:${stat.ino}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
            }
            bytes += Number(stat.size);
          } catch { incomplete = true; }
        } else incomplete = true;
      }
    } catch { incomplete = true; }
  }
  return { bytes, incomplete };
}

export async function reviewStorageCleanup(store, temporary) {
  temporary.checkRoot();
  const seen = new Set(), usage = {};
  for (const [kind, location] of categories) {
    usage[kind] = await directoryUsage(store.root, path.join(store.root, location), seen);
  }
  return { usage, workspaces: await temporary.review(), removedBytes: temporary.removedBytes };
}

export async function reconcileTemporaryReceipts(store, temporary) {
  temporary.checkRoot();
  for (const {session, paths} of store.all('SELECT session,paths FROM cleanup_retained')) {
    let entries;
    try { entries = JSON.parse(paths); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    const remaining = [];
    for (const entry of entries) {
      const file = entry?.path;
      if (!within(temporary.root, file) || pathKey(temporary.root) === pathKey(file)) {
        remaining.push(entry);
        continue;
      }
      try {
        // Keep replaced files and paths that cannot be safely read. Only a
        // verified missing path on the original data volume closes a receipt.
        const parent = path.dirname(file);
        temporary.checkRoot();
        if (pathKey(parent) !== pathKey(temporary.root) && !await checkedFile(temporary.root, parent, { directory: true, missing: true })) continue;
        await fs.lstat(file);
        remaining.push(entry);
      } catch (error) {
        if (error.code !== 'ENOENT') remaining.push(entry);
      }
    }
    if (remaining.length === entries.length) continue;
    temporary.checkRoot();
    if (remaining.length) store.run('UPDATE cleanup_retained SET paths=? WHERE session=? AND paths=?', JSON.stringify(remaining), session, paths);
    else store.run('DELETE FROM cleanup_retained WHERE session=? AND paths=?', session, paths);
  }
}
