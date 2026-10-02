import { DeletionControl } from './deletion-control.js';

// The confirmed request is durable before any await. Readers see deleted_at
// immediately; an OS operation keeps its task/locks until it actually settles.
export class SessionDeletion {
  constructor({ store, storage, waveform, media, density, idleMs = 30000, retryMs = 1000 }) {
    Object.assign(this, { store, storage, waveform, media, density, idleMs, retryMs });
    this.tasks = new Map(); this.closed = false;
  }
  get size() { return this.tasks.size; }
  has(id) { return this.tasks.has(id); }
  snapshot() {
    return [...this.tasks].map(([id, task]) => ({ id, updated: task.control.updated,
      phase: task.control.signal.aborted ? 'waiting' : task.control.phase,
      detail: task.control.signal.aborted ? `等待${task.control.detail || '文件操作'}结束后自动重试` : task.control.detail,
      completed: task.control.completed || 0, total: task.control.total || 0, attempt: task.attempt }));
  }
  start(id) {
    if (this.closed) throw new Error('后台正在退出，请稍后重试。');
    if (this.has(id)) return this.tasks.get(id);
    this.store.confirmDeletion(id);
    const task = { control: new DeletionControl({ idleMs: this.idleMs }), attempt: 1,
      accepted: { accepted: true, pending: true, id }, done: null };
    this.tasks.set(id, task);
    task.done = this.run(id, task).finally(() => { this.tasks.delete(id); task.control.close(); });
    // Background submissions have no waiting HTTP handler to observe failure.
    task.done.catch(() => {});
    return task;
  }
  async delete(id, { signal } = {}) {
    if (this.has(id)) throw new Error('这份素材正在删除，请等待完成。');
    const task = this.start(id);
    const abort = () => task.control.stop();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await task.control.respond(task.done); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async run(id, task) {
    for (;;) {
      try { return await this.remove(id, task.control); }
      catch (error) {
        const phase = task.control.phase || 'resources';
        this.store.run('UPDATE sessions SET purge_error=? WHERE id=?', `${error.message}（${task.control.detail || phase}）`, id);
        console.warn(JSON.stringify({ event: 'material-delete-retry', session: id, phase, attempt: task.attempt, code: error.code || 'DELETE_FAILED' }));
        // Only retry once promptly, after every issued operation has settled.
        // Further attempts use durable, rate-limited maintenance (also after restart).
        if (this.closed || error.code !== 'DELETION_STOPPED' || task.attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, this.retryMs));
        if (this.closed) throw error;
        task.control.close(); task.control = new DeletionControl({ idleMs: this.idleMs }); task.attempt++;
      }
    }
  }
  async remove(id, control) {
    const { store, storage, waveform, media, density } = this;
    const resources = [
      ['素材整理', storage, () => storage.blockSession(id)],
      ['音频波形', waveform, () => waveform.cancelSession(id)],
      ['视频预览与信息读取', media, () => media.cancelPreviews(id)],
      ['弹幕预处理', store.preparation, () => store.preparation.cancelSession(id)],
      ['缓存读取', store.renderCache, () => store.renderCache.cancelSession(id)]
    ].filter(([, owner]) => owner);
    const pending = new Set(resources.map(([name]) => name));
    control.stage('resources', [...pending].join('、'));
    try {
      // Call every stopper synchronously before awaiting any of them.
      const results = await Promise.allSettled(resources.map(([name,, stop]) => {
        try { return Promise.resolve(stop()).finally(() => {
          pending.delete(name);
          if (!control.signal.aborted) { control.detail = [...pending].join('、'); control.progress(); }
        }); } catch (error) { return Promise.reject(error); }
      }));
      control.check();
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      return await store.deleteSession(id, true, { control, resourcesStopped: true });
    } finally {
      density.drop(id);
      for (const [, owner] of resources) owner.allowSession(id);
    }
  }
  async close() {
    this.closed = true;
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.control.stop();
    await Promise.allSettled(tasks.map(task => task.done));
  }
}
