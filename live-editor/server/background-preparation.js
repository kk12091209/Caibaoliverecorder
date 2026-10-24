import {PreparationReconciliation} from './preparation-reconciliation.js';
import {LivePreparationPolicy} from './live-preparation-policy.js';

const ACTIVE = new Set(['recording', 'waiting', 'finishing', 'importing']);
const interrupted = error => ['AbortError', 'PREP_CANCELLED', 'ABORT_ERR'].includes(error?.name) || ['PREP_CANCELLED', 'ABORT_ERR'].includes(error?.code);
const finite = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;

// Scheduling only: render plans, fingerprints, immutable files and disk limits
// belong to Media/RenderCache. User export jobs are never modified here.
export class BackgroundPreparation {
  constructor(store, media, { busyReason = () => '', now = Date.now, pollMs = 1000, idleGraceMs = 3000, enabled = true, reconciliationOptions, liveOptions = {} } = {}) {
    this.store = store; this.media = media; this.busyReason = busyReason; this.now = now;
    this.pollMs = Math.max(10, finite(pollMs, 1000)); this.idleGraceMs = finite(idleGraceMs, 3000);
    this.closed = false; this.started = false; this.timer = null; this.wakeTimer = null; this.active = null;
    this.blocked = new Map(); this.changing = new Map(); this.foregroundHolds = 0; this.idleSince = null; this.notBefore = 0;
    this.lastError = ''; this.closing = null;
    this.liveContext = liveOptions.context || (() => ({}));
    this.livePolicy = liveOptions.policy || new LivePreparationPolicy({now});
    const liveSaved = store.setting('livePreparationEnabled');
    this.liveEnabled = typeof liveSaved === 'boolean' ? liveSaved : liveOptions.enabled === true;
    if (typeof liveSaved !== 'boolean') store.setting('livePreparationEnabled', this.liveEnabled);
    this.liveState = {active:false,reason:this.liveEnabled ? 'idle' : 'disabled',sessionId:null};
    store.db.exec(`CREATE TABLE IF NOT EXISTS preparation_seen(
      session TEXT PRIMARY KEY REFERENCES sessions(id),eligible INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS preparation_jobs(
      session TEXT PRIMARY KEY REFERENCES sessions(id),status TEXT NOT NULL DEFAULT 'queued',
      prepared_seconds REAL NOT NULL DEFAULT 0,total_seconds REAL NOT NULL DEFAULT 0,bytes REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',updated TEXT NOT NULL DEFAULT '',
      paused INTEGER NOT NULL DEFAULT 0,next_retry REAL NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,
      live_next_source_seconds REAL);
      CREATE INDEX IF NOT EXISTS preparation_status_session ON preparation_jobs(status,session);`);
    // NULL is ordinary idle scheduling; zero is a live metadata wait; a
    // positive value is the media-time boundary of the next useful live check.
    if(!store.all('PRAGMA table_info(preparation_jobs)').some(column=>column.name==='live_next_source_seconds'))store.db.exec('ALTER TABLE preparation_jobs ADD COLUMN live_next_source_seconds REAL');
    const saved = store.setting('backgroundPreparationEnabled');
    this.enabled = typeof saved === 'boolean' ? saved : enabled !== false;
    if (typeof saved !== 'boolean') store.setting('backgroundPreparationEnabled', this.enabled);
    store.run("UPDATE preparation_jobs SET status=CASE WHEN paused=1 THEN 'paused' ELSE 'queued' END,reason=CASE WHEN paused=1 THEN 'user' ELSE '' END WHERE status='preparing'");
    const first = store.setting('backgroundPreparationBaselineEstablished') !== true;
    store.transaction(() => {
      this.discover(first);
      if (first) store.setting('backgroundPreparationBaselineEstablished', true);
    });
    this.reconciliation=new PreparationReconciliation(this,reconciliationOptions);
  }
  stamp() { return new Date(this.now()).toISOString(); }
  ensureOpen() { if (this.closed) throw new Error('后台预处理服务已关闭。'); }
  session(id) { const session = this.store.session(id); if (!session) throw new Error('素材不存在或已经删除。'); return session; }
  snapshot() { return this.status(); }
  status(id) {
    const columns = 'p.session,p.status,p.prepared_seconds AS preparedSeconds,p.total_seconds AS totalSeconds,p.bytes,p.reason,p.error';
    if (id !== undefined) return this.store.get(`SELECT ${columns} FROM preparation_jobs p JOIN sessions s ON s.id=p.session WHERE p.session=? AND s.deleted_at=''`, id) || null;
    return { enabled: this.enabled, liveEnabled:this.liveEnabled, live:{...this.liveState,active:!!this.active?.live}, items: this.store.all(`SELECT ${columns} FROM preparation_jobs p JOIN sessions s ON s.id=p.session WHERE s.deleted_at='' ORDER BY s.created DESC,p.session`) };
  }
  discover(first = false) {
    if (this.closed) return;
    const sessions = this.store.all("SELECT s.id,s.status,s.duration,v.eligible FROM sessions s LEFT JOIN preparation_seen v ON v.session=s.id WHERE s.deleted_at='' AND (v.session IS NULL OR (v.eligible=0 AND s.status IN ('recording','waiting','finishing','importing')))");
    for (const session of sessions) {
      const seen = session.eligible !== null && session.eligible !== undefined;
      const eligible = ACTIVE.has(session.status) || (seen ? !!session.eligible : !first);
      if (session.eligible === null || session.eligible === undefined) this.store.run('INSERT OR IGNORE INTO preparation_seen(session,eligible) VALUES(?,?)', session.id, +eligible);
      else if (ACTIVE.has(session.status) && !session.eligible) this.store.run('UPDATE preparation_seen SET eligible=1 WHERE session=?', session.id);
      if (eligible || ACTIVE.has(session.status)) this.store.run("INSERT OR IGNORE INTO preparation_jobs(session,status,total_seconds,reason,updated) VALUES(?,?,?,?,?)", session.id,
        session.status === 'finished' ? (this.enabled ? 'queued' : 'waiting') : 'waiting', finite(session.duration), session.status === 'finished' ? (this.enabled ? '' : 'disabled') : 'source', this.stamp());
    }
  }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    this.timer = setInterval(() => { void this.tick().catch(error => { this.lastError = error.message; }); }, this.pollMs);
    this.timer.unref?.(); this.wake();
  }
  wake() {
    if (!this.started || this.closed || this.wakeTimer) return;
    this.wakeTimer = setImmediate(() => {
      this.wakeTimer = null;
      if (!this.closed) void this.tick().catch(error => { this.lastError = error.message; });
    });
    this.wakeTimer.unref?.();
  }
  gate() {
    if (!this.enabled) return 'disabled';
    if (this.foregroundHolds) return 'foreground';
    const reason = this.busyReason();
    if (reason) return typeof reason === 'string' ? reason : 'foreground';
    if (this.media.hasForegroundWork?.({includeInteractive:false})) return 'foreground';
    return '';
  }
  row(id) { return this.store.get('SELECT * FROM preparation_jobs WHERE session=?', id); }
  reconcileExports() { return this.reconciliation.tick(); }
  available(id) { return !this.closed && !this.blocked.has(id) && !this.changing.has(id) && !this.store.deletions?.has(id) && !!this.store.session(id); }
  waitRows(reason, preserveActive = false) {
    this.store.run("UPDATE preparation_jobs SET status='waiting',reason=?,updated=? WHERE paused=0 AND status IN ('queued','preparing','waiting') AND (status!='waiting' OR reason!=?) AND session!=?", reason, this.stamp(), reason, preserveActive ? this.active?.id || '' : '');
  }
  interrupt(reason, id) {
    const active = this.active;
    if (active && (id === undefined || active.id === id)) {
      active.reason = reason;
      active.controller.abort();
      return active.done;
    }
    return Promise.resolve();
  }
  async tick() {
    if (this.closed) return;
    this.discover();
    let reason;
    try { reason = this.gate(); }
    catch (error) { this.lastError = error.message; reason = 'foreground'; }
    if (reason === 'recording' && this.liveEnabled) return this.tickLive();
    if (reason) {
      this.liveState = {active:false,sessionId:this.active?.live ? this.active.id : null,reason};
      // An explicit export consumer owns only this currently running batch.
      // Recording, invalidation, user pause and shutdown still cancel it.
      if(this.active?.exportConsumers?.size&&['foreground','export'].includes(reason)&&this.media.isRecording?.()!==true){
        this.waitRows(reason,true);return this.reconcileExports();
      }
      this.idleSince = null; this.waitRows(reason);
      // Recognition of an already saved export does no encoding and should
      // also settle stale errors while the user is previewing another video.
      return Promise.all([this.interrupt(reason),this.reconcileExports()]);
    }
    this.liveState = {active:!!this.active?.live,sessionId:this.active?.live ? this.active.id : null,reason:this.liveEnabled ? 'idle' : 'disabled'};
    await this.reconcileExports();
    if(this.closed)return;
    if (this.active) return this.active.done;
    const now = this.now();
    this.idleSince ??= now;
    if (now < this.notBefore || now - this.idleSince < this.idleGraceMs) { this.waitRows('idle'); return; }
    // Continue a partially prepared material before starting another one. The
    // preference survives restarts and avoids alternating large plans evicting
    // each other's blocks under the shared cache budget. Paused/backoff rows
    // remain excluded, so they never prevent other materials from progressing.
    const candidates = this.store.all("SELECT * FROM preparation_jobs WHERE paused=0 AND status IN ('queued','waiting') AND (next_retry<=? OR live_next_source_seconds IS NOT NULL) ORDER BY prepared_seconds DESC,updated,session", now);
    for (const row of candidates) {
      if (!this.available(row.session)) continue;
      const session = this.store.session(row.session), sources = this.store.sources(row.session);
      if (session.status !== 'finished' || !sources.length || sources.some(source => source.closed !== 2 || source.error)) {
        this.store.run("UPDATE preparation_jobs SET status='waiting',reason='source' WHERE session=?", row.session); continue;
      }
      // A newly queued item must be checked even if history spans many batches.
      await this.reconciliation.check(row.session);
      if(this.closed||this.gate()||this.active)return this.active?.done;
      if(!this.available(row.session)||!['queued','waiting'].includes(this.row(row.session)?.status))continue;
      const active = { id: row.session, generation: row.generation, controller: new AbortController(), reason: '', done: null };
      this.active = active;
      this.store.run("UPDATE preparation_jobs SET status='preparing',reason='',error='',live_next_source_seconds=NULL,updated=? WHERE session=?", this.stamp(), row.session);
      active.done = Promise.resolve().then(() => this.perform(active)).finally(() => {
        if (this.active === active) this.active = null;
        // A following block gets a new event-loop turn; foreground requests can
        // claim the service before another decoder is launched.
        this.wake();
      });
      return active.done;
    }
  }
  async tickLive() {
    let context, decision;
    try {
      context = await this.liveContext();
      if(this.closed)return;
      context = {...context,recordingIdentity:context?.recordingIdentity || context?.sessionId,
        foreground:!!context?.foreground || this.foregroundHolds > 0 || !!this.media.hasForegroundWork?.({includeInteractive:true})};
      decision = await this.livePolicy.evaluate(context);
    } catch(error) {
      this.lastError=error.message;decision={allowed:false,urgent:true,reason:'resources-unknown'};
    }
    if(this.closed)return;
    const currentGate=this.gate();
    if(currentGate!=='recording'||!this.liveEnabled){
      if(currentGate)return Promise.all([this.interrupt(currentGate),this.reconcileExports()]);
      return;
    }
    const id=context?.sessionId, session=id && this.store.session(id);
    const valid=!!id && session?.status==='recording' && context.recordingCount===1 && this.available(id);
    if(!valid)decision={allowed:false,urgent:true,reason:'recording'};
    const reason=decision.reason || (decision.allowed ? '' : 'recording');
    this.liveState={active:!!this.active?.live,sessionId:id || null,reason,budgetMs:decision.budgetMs,usedMs:decision.usedMs,retryAfterMs:decision.retryAfterMs};
    this.idleSince=null;
    // Admission belongs to this exact live session. It never opens an idle
    // material, or an ordinary background process, while recording is active.
    if(this.active && (!this.active.live || this.active.id!==id)) {
      this.waitRows('recording');return Promise.all([this.interrupt('recording'),this.reconcileExports()]);
    }
    if(!decision.allowed) {
      this.waitRows(reason,!decision.urgent);
      if(decision.urgent)return Promise.all([this.interrupt(reason),this.reconcileExports()]);
      await this.reconcileExports();
      return this.active?.done;
    }
    await this.reconcileExports();
    if(this.closed||!this.liveEnabled||this.gate()!=='recording')return;
    if(this.active)return this.active.done;
    if(this.now()<this.notBefore){this.liveState.reason='foreground';this.waitRows('foreground');return;}
    const row=this.row(id);
    const currentSession=this.store.session(id);
    if(!this.available(id)||currentSession?.status!=='recording'||!row||row.paused||!['queued','waiting'].includes(row.status)||row.next_retry>this.now()||finite(row.live_next_source_seconds)>finite(currentSession.duration))return;
    const token=this.livePolicy.start(context.recordingIdentity);
    if(!token)return;
    const active={id,generation:row.generation,controller:new AbortController(),reason:'',done:null,
      live:{tailSeconds:finite(decision.tailSeconds,90)},token,startedAt:this.now()};
    this.active=active;
    this.store.run("UPDATE preparation_jobs SET status='preparing',reason='',error='',live_next_source_seconds=NULL,updated=? WHERE session=?",this.stamp(),id);
    active.done=Promise.resolve().then(()=>this.perform(active)).finally(()=>{
      if(this.active===active)this.active=null;
      this.wake();
    });
    return active.done;
  }
  current(active) {
    if (!this.available(active.id)) return null;
    const row = this.row(active.id);
    return row && row.generation === active.generation ? row : null;
  }
  progress(active, result) {
    const row = this.current(active);
    if (!row || row.paused || active.controller.signal.aborted) return;
    const total = finite(result?.totalSeconds, row.total_seconds);
    const prepared = Math.min(total, finite(result?.preparedSeconds, row.prepared_seconds));
    this.store.run('UPDATE preparation_jobs SET prepared_seconds=?,total_seconds=?,bytes=?,updated=? WHERE session=? AND generation=?',
      prepared, total, finite(result?.bytes, row.bytes), this.stamp(), active.id, active.generation);
  }
  async perform(active) {
    let outcome='interrupted';
    try {
      if (active.controller.signal.aborted || !this.current(active)) return;
      const result = await this.media.prepareNext(active.id, { signal: active.controller.signal, ...(active.live ? {live:active.live} : {}), onProgress: value => this.progress(active, value) });
      if (active.controller.signal.aborted) throw Object.assign(new Error('后台预处理已让出资源。'), { code: 'PREP_CANCELLED' });
      const row = this.current(active); if (!row || row.paused) return;
      if (!result || typeof result.done !== 'boolean') throw new Error('后台预处理没有返回有效状态。');
      this.progress(active, result);
      outcome='success';
      // Live completion is only a stable-prefix checkpoint, never a finished
      // material. The idle path still verifies and prepares the final tail.
      const waiting=active.live && result.waiting;
      const waitReason=waiting ? result.reason || (typeof result.waiting==='string' ? result.waiting : 'source') : '';
      const retryMs=waiting ? Math.min(30000,Math.max(1000,finite(result.retryAfterMs,waitReason==='tail'?30000:10000))) : 0;
      this.store.run('UPDATE preparation_jobs SET status=?,reason=?,error=?,next_retry=?,live_next_source_seconds=?,updated=? WHERE session=? AND generation=?', waiting ? 'waiting' : !active.live && result.done ? 'ready' : 'queued', waitReason, '', waiting ? this.now()+retryMs : 0, waiting ? waitReason==='tail' ? finite(result.nextEligibleAt) : 0 : null, this.stamp(), active.id, active.generation);
    } catch (error) {
      const row = this.current(active); if (!row || row.paused) return;
      if (active.controller.signal.aborted || interrupted(error)) {
        this.idleSince = null;
        this.store.run("UPDATE preparation_jobs SET status='waiting',reason=?,updated=? WHERE session=? AND generation=?", active.reason || 'foreground', this.stamp(), active.id, active.generation);
      } else if (error?.code === 'PREP_SPACE') {
        outcome='failure';
        // A plan larger than the cache budget cannot recover by waiting. Keep
        // it parked until an explicit retry, otherwise another material can
        // evict its blocks and start an endless overnight rebuild cycle.
        const retry = error.capacity === true ? Number.MAX_SAFE_INTEGER : this.now() + 30000;
        this.store.run("UPDATE preparation_jobs SET status='waiting',reason='space',error=?,next_retry=?,updated=? WHERE session=? AND generation=?", error.message || '磁盘空间不足，后台预处理已暂停。', retry, this.stamp(), active.id, active.generation);
      } else {
        outcome='failure';
        // Unexpected renderer/storage errors require an explicit retry or a
        // changed edit. Do not repeatedly re-encode a broken input in a loop.
        if(active.live)this.store.run("UPDATE preparation_jobs SET status='waiting',reason='live-error',error=?,next_retry=?,live_next_source_seconds=0,updated=? WHERE session=? AND generation=?",error.message || '录制时提前处理已暂停。',this.now()+60000,this.stamp(),active.id,active.generation);
        else this.store.run("UPDATE preparation_jobs SET status='error',reason='',error=?,updated=? WHERE session=? AND generation=?", error.message || '后台预处理失败。', this.stamp(), active.id, active.generation);
      }
    } finally {
      if(active.live)this.livePolicy.finish(active.token,{outcome,elapsedMs:Math.max(0,this.now()-active.startedAt)});
    }
  }
  enqueue(id) {
    this.ensureOpen(); const session = this.session(id);
    this.store.run('INSERT INTO preparation_seen(session,eligible) VALUES(?,1) ON CONFLICT(session) DO UPDATE SET eligible=1', id);
    if (this.active?.id === id && !this.row(id)?.paused) return this.status(id);
    this.store.run("INSERT INTO preparation_jobs(session,total_seconds,updated) VALUES(?,?,?) ON CONFLICT(session) DO NOTHING", id, finite(session.duration), this.stamp());
    this.store.run('UPDATE preparation_jobs SET paused=0,status=?,reason=?,error=?,next_retry=0,live_next_source_seconds=NULL,updated=? WHERE session=?', this.enabled ? 'queued' : 'waiting', this.enabled ? '' : 'disabled', '', this.stamp(), id);
    this.reconciliation.mark(id);this.wake(); return this.status(id);
  }
  async pause(id) {
    this.ensureOpen(); this.session(id);
    if (!this.row(id)) this.enqueue(id);
    this.store.run("UPDATE preparation_jobs SET paused=1,status='paused',reason='user',updated=? WHERE session=?", this.stamp(), id);
    await this.interrupt('user', id); await this.media.discardPendingPreparation?.(id); return this.status(id);
  }
  resume(id) { return this.enqueue(id); }
  async setEnabled(value) {
    this.ensureOpen(); if (typeof value !== 'boolean') throw new Error('后台预处理开关必须为布尔值。');
    this.enabled = value; this.store.setting('backgroundPreparationEnabled', value); this.idleSince = null;
    if (!value) { this.waitRows('disabled'); await this.interrupt('disabled'); await this.media.discardPendingPreparation?.(); }
    else { this.store.run("UPDATE preparation_jobs SET status='queued',reason='' WHERE paused=0 AND status='waiting' AND reason='disabled'"); this.wake(); }
    return this.snapshot();
  }
  async setLiveEnabled(value) {
    this.ensureOpen();if(typeof value!=='boolean')throw new Error('录制时提前处理开关必须为布尔值。');
    this.liveEnabled=value;this.store.setting('livePreparationEnabled',value);
    this.liveState={active:!!this.active?.live,sessionId:this.active?.live ? this.active.id : null,reason:value ? 'idle' : 'disabled'};
    if(!value && this.active?.live)await this.interrupt('disabled');
    if(!value)await this.media.discardPendingPreparation?.();
    if(value)this.wake();
    return this.snapshot();
  }
  async yieldForForeground() {
    if (this.closed) return;
    this.foregroundHolds++; this.idleSince = null; this.notBefore = this.now() + this.idleGraceMs;
    try { await this.interrupt('foreground'); }
    finally { this.foregroundHolds--; this.idleSince = null; this.notBefore = this.now() + this.idleGraceMs; }
  }
  async yieldForExport(id,jobs){
    const active=this.active;
    if(active&&active.id===id&&this.store.session(id)?.status==='finished'&&this.store.sources(id).every(s=>s.closed===2)&&!active.controller.signal.aborted&&this.media.isRecording?.()!==true){
      this.foregroundHolds++;
      try{
        let matches=false;
        try{matches=await this.media.renderer.matchesPreparation(jobs);}catch{ /* A transfer miss retains the ordinary safe export. */ }
        if(matches&&this.active===active&&!active.controller.signal.aborted){
          const users=active.exportConsumers??=new Set();for(const job of jobs)users.add(job.id);
          return {done:active.done,release:async jobId=>{
            users.delete(jobId);
            if(!users.size&&this.active===active){active.reason='foreground';active.controller.abort();await active.done;}
          }};
        }
      }finally{this.foregroundHolds--;}
    }
    await this.yieldForForeground();return null;
  }
  async invalidate(id) {
    if (this.closed || !this.store.session(id)) return;
    this.reconciliation.mark(id);
    this.changing.set(id, (this.changing.get(id) || 0) + 1);
    try {
      const capacity = this.row(id)?.next_retry === Number.MAX_SAFE_INTEGER;
      this.store.run("UPDATE preparation_jobs SET generation=generation+1,status=CASE WHEN paused=1 THEN 'paused' ELSE ? END,prepared_seconds=0,bytes=0,reason=CASE WHEN paused=1 THEN 'user' ELSE ? END,error=CASE WHEN ? THEN error ELSE '' END,next_retry=?,live_next_source_seconds=NULL,updated=? WHERE session=?",
        capacity ? 'waiting' : 'queued', capacity ? 'space' : '', +capacity, capacity ? Number.MAX_SAFE_INTEGER : 0, this.stamp(), id);
      await this.interrupt('foreground', id);
      if (!this.closed && this.store.session(id)) await this.media.invalidatePreparation?.(id);
    } finally {
      const count = this.changing.get(id) || 0; if (count > 1) this.changing.set(id, count - 1); else this.changing.delete(id);
      this.wake();
    }
  }
  async cancelSession(id) {
    this.blocked.set(id, (this.blocked.get(id) || 0) + 1);
    await this.interrupt('source', id);
    await this.media.discardPendingPreparation?.(id);
  }
  allowSession(id) {
    const count = this.blocked.get(id) || 0; if (count > 1) this.blocked.set(id, count - 1); else this.blocked.delete(id);
    if (!this.closed) {
      this.store.run("UPDATE preparation_jobs SET status='queued',reason='' WHERE session=? AND paused=0 AND status='preparing'", id);
      this.wake();
    }
  }
  async forgetSession(id, { alreadyStopped=false }={}) {
    if(!alreadyStopped)await this.interrupt('source', id);
    this.store.run('DELETE FROM preparation_jobs WHERE session=?', id);
    this.store.run('DELETE FROM preparation_seen WHERE session=?', id);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.started = false;
    clearInterval(this.timer); clearImmediate(this.wakeTimer); this.timer = null; this.wakeTimer = null;
    this.closing = Promise.all([this.interrupt('closed'),this.reconciliation.close()]).then(()=>this.media.discardPendingPreparation?.());
    return this.closing;
  }
}
