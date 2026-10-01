import { DELETION_FAILED } from './deletion-control.js';
// Only resume deletions the user already confirmed. Never sweep unreferenced
// originals/chunks: missing database rows are not proof that footage is trash.
export class DeletionMaintenance {
  constructor(store, { remove, busy = () => false, now = Date.now, interval = 60000 } = {}) {
    this.store = store; this.remove = remove || (id => store.deleteSession(id, true));
    this.busy = busy; this.now = now; this.interval = interval; this.next = 0;
    this.running = null; this.closed = false; this.lastError = '';
  }
  tick() {
    if (this.running) return this.running;
    if (this.closed || this.busy() || this.now() < this.next) return Promise.resolve();
    this.next = this.now() + this.interval;
    this.running = this.sweep().finally(() => { this.running = null; });
    return this.running;
  }
  async sweep() {
    const pending = this.store.all("SELECT id FROM sessions WHERE deleted_at<>'' AND purge_started_at<>'' AND purge_error<>? ORDER BY purge_started_at",DELETION_FAILED);
    for (const { id } of pending) {
      if (this.closed || this.busy()) return;
      try { await this.remove(id); }
      catch (error) {
        this.lastError = error.message;
        this.store.run('UPDATE sessions SET purge_error=? WHERE id=?',error.message,id);
      }
    }
    if (!this.closed && !this.busy()) this.reclaimEmptyDatabase();
  }
  reclaimEmptyDatabase() {
    const store = this.store;
    if (store.deletions?.size || store.get('SELECT id FROM sessions LIMIT 1') || store.get("SELECT id FROM jobs WHERE status IN ('queued','running','finalizing','saving','save_failed','cancelling') LIMIT 1")) return;
    const free = store.get('PRAGMA freelist_count').freelist_count * store.get('PRAGMA page_size').page_size;
    // SQLite otherwise reuses freed pages without returning disk space. Only
    // compact an idle, completely empty material library, not on each deletion.
    if (free >= 1024 * 1024) store.db.exec('VACUUM');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close() { this.closed = true; return this.running || Promise.resolve(); }
}
