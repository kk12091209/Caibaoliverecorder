import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertDeletable, prepareDeletion, removeDeletionFiles } from './deletion.js';
import { sourceReaderCount } from './storage-files.js';
import { isStickerPlaceholder } from './chat-filter.js';
const sourcePathKey = file => process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'editor.sqlite'));
    this.db.function('is_sticker_placeholder', { deterministic: true }, text => Number(isStickerPlaceholder(text)));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, room INTEGER, created TEXT, status TEXT,
        duration REAL DEFAULT 0, error TEXT DEFAULT '', archive TEXT DEFAULT '', archive_status TEXT DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, session TEXT REFERENCES sessions(id), path TEXT UNIQUE,
        xml TEXT, start REAL, wall TEXT, closed INTEGER DEFAULT 0, pos INTEGER DEFAULT 13, xmlpos INTEGER DEFAULT 0,
        header TEXT DEFAULT '{}', duration REAL DEFAULT 0, error TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS chunks(source TEXT REFERENCES sources(id), seq INTEGER, start REAL, end REAL,
        path TEXT, bytes INTEGER, PRIMARY KEY(source, seq));
      CREATE INDEX IF NOT EXISTS chunk_time ON chunks(source,start);
      CREATE TABLE IF NOT EXISTS keyframes(source TEXT, time REAL, seq INTEGER, offset INTEGER,
        PRIMARY KEY(source,seq,offset));
      CREATE INDEX IF NOT EXISTS key_time ON keyframes(source,time);
      CREATE TABLE IF NOT EXISTS source_storage(source TEXT PRIMARY KEY REFERENCES sources(id),mode TEXT NOT NULL DEFAULT 'chunks',status TEXT NOT NULL DEFAULT 'new',reason TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',verified_bytes INTEGER NOT NULL DEFAULT 0,freed_bytes INTEGER NOT NULL DEFAULT 0,next_retry INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS direct_keyframes(source TEXT REFERENCES sources(id),seq INTEGER,chunk_offset INTEGER,time REAL,raw_offset INTEGER,PRIMARY KEY(source,seq,chunk_offset));
      CREATE TABLE IF NOT EXISTS compact_chunks(source TEXT REFERENCES sources(id),seq INTEGER,path TEXT,fingerprint TEXT,sha256 TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source,seq));
      CREATE TABLE IF NOT EXISTS danmaku(id TEXT PRIMARY KEY, session TEXT REFERENCES sessions(id), source TEXT,
        time REAL, user TEXT, text TEXT, type TEXT, color TEXT);
      CREATE INDEX IF NOT EXISTS dm_time ON danmaku(session,time);
      CREATE INDEX IF NOT EXISTS dm_session ON danmaku(session);
      CREATE TABLE IF NOT EXISTS danmaku_filters(message TEXT PRIMARY KEY REFERENCES danmaku(id), reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edits(session TEXT PRIMARY KEY REFERENCES sessions(id), revision INTEGER,
        data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session TEXT REFERENCES sessions(id), created TEXT,
        status TEXT, progress REAL DEFAULT 0, data TEXT, file TEXT DEFAULT '', error TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS deleted_source_paths(path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
    `);
    if (!this.all('PRAGMA table_info(sessions)').some(c => c.name === 'deleted_at')) this.db.exec("ALTER TABLE sessions ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
    for (const name of ['purged_at','purge_started_at','purge_error']) if (!this.all('PRAGMA table_info(sessions)').some(c => c.name === name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
    if (!this.all('PRAGMA table_info(jobs)').some(c => c.name === 'mode')) this.db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'clean'");
    if (!this.all('PRAGMA table_info(source_storage)').some(c => c.name === 'eligible')) this.db.exec('ALTER TABLE source_storage ADD COLUMN eligible INTEGER NOT NULL DEFAULT 0');
    this.db.prepare("UPDATE jobs SET status='failed',error='上次导出被中断，可重新导出。' WHERE status IN ('running','queued')").run();
    this.db.prepare("UPDATE jobs SET status='cancelled',error='' WHERE status='cancelling'").run();
    this.db.prepare("UPDATE sessions SET archive_status='pending' WHERE archive_status='running'").run();
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createSession({ id = randomUUID(), title = '未命名录像', room = 0, created = new Date().toISOString(), status = 'recording' } = {}) {
    this.run('INSERT OR IGNORE INTO sessions(id,title,room,created,status) VALUES(?,?,?,?,?)', id, title, room, created, status);
    return this.session(id);
  }
  session(id) { return this.get("SELECT * FROM sessions WHERE id=? AND deleted_at=''", id); }
  sessions() { return this.all("SELECT * FROM sessions WHERE deleted_at='' ORDER BY created DESC LIMIT 200"); }
  pendingCleanup() { return this.all("SELECT id,title,created,status,duration,purge_started_at,purge_error FROM sessions WHERE deleted_at!='' AND purge_started_at!='' AND purged_at='' ORDER BY purge_started_at DESC"); }
  async deleteSession(id, confirmed) {
    if (confirmed !== true) throw new Error('请先确认是否删除这份素材。');
    this.deletions??=new Set();
    if(this.deletions.has(id))throw new Error('这份素材正在删除，请稍候。');
    this.deletions.add(id);
    let started=false, preparationBlocked=false, cacheBlocked=false;
    try {
      assertDeletable(this,id);
      if(this.preparation){preparationBlocked=true;await this.preparation.cancelSession(id);}
      if(this.renderCache){cacheBlocked=true;this.renderCache.blockSession(id);await this.renderCache.cancelSession(id);}
      if(this.storage?.currentSession===id||this.sources(id).some(source=>sourceReaderCount(this,source.id)))throw new Error('素材仍在读取或整理，请等待结束后再删除。');
      const plan=await prepareDeletion(this,id);
      this.transaction(()=>{
        assertDeletable(this,id);
        if(JSON.stringify(this.sources(id))!==plan.sourcesSnapshot)throw new Error('素材信息刚发生变化，请稍后重试删除。');
        if(JSON.stringify(this.all('SELECT chunks.* FROM chunks JOIN sources ON sources.id=chunks.source WHERE sources.session=? ORDER BY chunks.source,chunks.seq',id))!==plan.chunksSnapshot||this.get('SELECT archive FROM sessions WHERE id=?',id).archive!==plan.archive)throw new Error('素材文件清单刚发生变化，请稍后重试删除。');
        const now=new Date().toISOString();
        // Retain the manifest until physical cleanup succeeds, so partial
        // deletion remains retryable but cannot restore a damaged recording.
        this.run("UPDATE sessions SET deleted_at=CASE WHEN deleted_at='' THEN ? ELSE deleted_at END,purge_started_at=?,purge_error='' WHERE id=?",now,now,id);
      });
      started=true;
      const result=await removeDeletionFiles(this,id,plan);
      if(this.renderCache){
        const cache=await this.renderCache.removeSession(id);
        result.freedBytes+=cache.freedBytes;result.deletedFiles+=cache.deletedFiles;
        result.preserved.push(...cache.preserved.map(entry=>({...entry,cache:true})));
        if(cache.preserved.length)result.message+=' 部分预处理缓存身份异常或仍有未知文件，已保留。';
      }
      if(this.temporaryWorkspaces){
        const temporary=await this.temporaryWorkspaces.removeSession(id);
        result.freedBytes+=temporary.freedBytes;result.deletedFiles+=temporary.deletedFiles;
      }
      // Keep the durable source manifest until all internal work files are
      // gone. A failed unlink must remain retryable, including after restart.
      if(result.pending || result.preserved.some(entry=>entry.cache)) {
        const reason=result.preserved.find(entry=>entry.cache)?.reason || '内部片段目录仍有未清理的文件。';
        this.run('UPDATE sessions SET purge_error=? WHERE id=?',reason,id);
        return {...result,ok:false,pending:true,message:'素材清理未完成，空闲时会自动重试；可在设置中查看。'};
      }
      this.transaction(()=>{
        for(const source of this.sources(id)) {
          // A tiny path receipt prevents delayed webhooks/recovery scans from
          // resurrecting deleted files without retaining session/source rows.
          this.run('INSERT OR IGNORE INTO deleted_source_paths VALUES(?)',sourcePathKey(source.path));
          this.run('DELETE FROM chunks WHERE source=?',source.id);
          this.run('DELETE FROM keyframes WHERE source=?',source.id);
          this.run('DELETE FROM direct_keyframes WHERE source=?',source.id);
          this.run('DELETE FROM compact_chunks WHERE source=?',source.id);
          this.run('DELETE FROM source_storage WHERE source=?',source.id);
          if(this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='waveform_blocks'"))this.run('DELETE FROM waveform_blocks WHERE source=?',source.id);
          this.run('DELETE FROM settings WHERE key=?','metadata:'+source.id);
        }
        this.run('DELETE FROM danmaku_filters WHERE message IN (SELECT id FROM danmaku WHERE session=?)',id);
        this.run('DELETE FROM danmaku WHERE session=?',id);
        this.run('DELETE FROM edits WHERE session=?',id);
        for(const table of ['preparation_jobs','preparation_seen'])if(this.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table))this.run(`DELETE FROM ${table} WHERE session=?`,id);
        this.run('UPDATE jobs SET session=NULL WHERE session=?',id);
        this.run('DELETE FROM sources WHERE session=?',id);
        this.run('DELETE FROM sessions WHERE id=?',id);
      });
      await this.preparation?.forgetSession(id);
      return {ok:true,...result};
    } catch(error) {
      if(started||this.get('SELECT purge_started_at FROM sessions WHERE id=?',id)?.purge_started_at)this.run('UPDATE sessions SET purge_error=? WHERE id=?',error.message,id);
      throw error;
    } finally {
      if(cacheBlocked)this.renderCache.allowSession(id);
      if(preparationBlocked)this.preparation.allowSession(id);
      this.deletions.delete(id);
    }
  }
  sources(id) { return this.all('SELECT * FROM sources WHERE session=? ORDER BY start,wall,id', id); }
  wasSourceDeleted(file) { return !!this.get('SELECT path FROM deleted_source_paths WHERE path=?',sourcePathKey(file)); }
  addSource(session, file, start = 0, wall = new Date().toISOString(), closed = false) {
    file = path.resolve(file);
    if(this.wasSourceDeleted(file))throw new Error('这份原始素材已经删除。');
    const existing = this.get('SELECT * FROM sources WHERE path=?', file);
    if (existing) { if (closed) this.run('UPDATE sources SET closed=1 WHERE id=?', existing.id); return existing; }
    const id = randomUUID();
    this.run('INSERT INTO sources(id,session,path,xml,start,wall,closed) VALUES(?,?,?,?,?,?,?)', id, session, file, file.replace(/\.flv$/i, '.xml'), start, wall, +closed);
    return this.get('SELECT * FROM sources WHERE id=?', id);
  }
  edit(id) { const row = this.get('SELECT * FROM edits WHERE session=?', id); return row ? { revision: row.revision, ...JSON.parse(row.data), filterLottery: true } : { revision: 0, ranges: [], excluded: [], undo: [], filterLottery: true }; }
  saveEdit(id, input) {
    if (!this.session(id)) throw new Error('找不到录像。');
    const current = this.edit(id);
    if (Number(input.revision) !== current.revision) { const e = new Error('剪辑已被另一个窗口更新，请刷新后重试。'); e.status = 409; throw e; }
    const ranges = validateRanges(input.ranges || [], this.session(id).duration, true).map((r,i)=>({...r,selected:input.ranges[i].selected!==false}));
    const excluded = [...new Set(input.excluded || [])];
    if (excluded.length > 200000 || excluded.some(x => typeof x !== 'string' || x.length > 100)) throw new Error('弹幕编辑数据无效。');
    const undo = (input.undo || []).slice(-100).map(x => String(x).slice(0, 100));
    if (input.filterLottery !== undefined && typeof input.filterLottery !== 'boolean') throw new Error('抽奖弹幕设置无效。');
    const data = { ranges, excluded, undo, filterLottery: true };
    this.run('INSERT INTO edits VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision,data=excluded.data', id, current.revision + 1, JSON.stringify(data));
    return { revision: current.revision + 1, ...data };
  }
  messages(id, from = 0, to = Number.MAX_SAFE_INTEGER, search = '', limit = 300, filterLottery = this.edit(id).filterLottery !== false) {
    const lottery = filterLottery ? " AND NOT EXISTS (SELECT 1 FROM danmaku_filters f WHERE f.message=danmaku.id AND f.reason='lottery')" : '';
    return this.all("SELECT * FROM danmaku WHERE session=? AND type='d' AND time>=? AND time<=? AND (text LIKE ? OR user LIKE ?) AND NOT is_sticker_placeholder(text)" + lottery + " ORDER BY time,id LIMIT ?", id, from, to, `%${search}%`, `%${search}%`, limit);
  }
  setting(key, value) {
    if (value !== undefined) this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
    const row = this.get('SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) : undefined;
  }
  close() { this.db.close(); }
}

export function validateRanges(ranges, duration, allowEmpty = false) {
  if (!Array.isArray(ranges) || ranges.length > 100 || (!allowEmpty && !ranges.length)) throw new Error('请选择 1 至 100 个片段。');
  return ranges.map(r => {
    const start = Number(r.start), end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.05) throw new Error('选段范围超出已录制内容。');
    return { start, end: Math.min(duration, end) };
  });
}
