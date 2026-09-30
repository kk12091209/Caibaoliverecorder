// Persisted jobs, rather than an in-memory seen set, are the completion receipt.
export function fullCleanAttempt(store, id) {
  return store.all('SELECT * FROM jobs WHERE session=? ORDER BY created', id).find(row => {
    let job;try{job=JSON.parse(row.data||'{}');}catch{return false;}
    return job?.scope === 'full' && (job.mode || row.mode) === 'clean'
      && (['done', 'queued', 'running', 'finalizing', 'saving', 'save_failed', 'cancelling'].includes(row.status) || job.automaticFullClean === true);
  });
}

export class CompletedRecording {
  constructor(store, media, preparation) {
    this.store = store; this.media = media; this.preparation = preparation;
    this.closed = false; this.pending = null; this.lastError = '';
  }
  ready(id) {
    const session = this.store.session(id), sources = this.store.sources(id);
    return !this.closed && !this.media.closed && !this.store.deletions?.has(id)
      && !this.media.blockedSessions.has(id) && session?.status === 'finished' && session.duration > 0
      && sources.length > 0 && sources.every(source => source.closed === 2 && !source.error);
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.discover().finally(() => { this.pending = null; });
    return this.pending;
  }
  async discover() {
    for (const {id} of this.store.all("SELECT id FROM sessions WHERE status='finished' AND deleted_at='' ORDER BY created")) {
      if (!this.ready(id)) continue;
      try {
        if (!fullCleanAttempt(this.store, id)) await this.media.enqueue(id, {scope: 'full', mode: 'clean'}, {automatic: true});
        // enqueue() interrupts preprocessing while the foreground export runs.
        // Never enqueue again over a ready/paused/existing preparation record.
        if (this.ready(id) && !this.preparation.row(id)) await this.preparation.enqueue(id);
      } catch (error) { this.lastError = error.message; }
    }
  }
  async close() { this.closed = true; await this.pending; }
}
