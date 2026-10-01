export const DELETION_FAILED = '删除失败，请重试。';
const stopped = () => Object.assign(new Error(DELETION_FAILED), { code: 'DELETION_STOPPED', status: 408 });

// Stop scheduling on a stall, but let issued filesystem mutations settle
// before releasing their locks/manifest for a retry.
export class DeletionControl {
  constructor({ idleMs = 30000, signal } = {}) {
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.idleMs = idleMs; this.updated = Date.now(); this.timer = null;
    this.external = signal; this.abort = () => this.stop();
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.stop(); else this.progress();
  }
  check() { if (this.signal.aborted) throw this.signal.reason; }
  progress() {
    this.check(); this.updated = Date.now(); clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.idleMs); this.timer.unref?.();
  }
  stop() { clearTimeout(this.timer); if (!this.signal.aborted) this.controller.abort(stopped()); }
  // Cancellable waits are for reads/resource shutdown, never an unlink.
  async wait(operation) {
    const value = await this.respond(operation); this.progress(); return value;
  }
  async respond(operation) {
    const promise = Promise.resolve(operation); let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { this.signal.removeEventListener('abort', abort); }
  }
  close() { clearTimeout(this.timer); this.external?.removeEventListener('abort', this.abort); }
}
