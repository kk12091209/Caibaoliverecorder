import { DeletionControl } from './deletion-control.js';

// Coordinate readers and cancellation here; Store owns durable deletion and
// deletion.js owns file identity checks. A timed-out OS call keeps its lock
// until it settles, while the HTTP request can return immediately.
export class SessionDeletion {
  constructor({ store, storage, waveform, media, density, idleMs = 30000 }) {
    Object.assign(this, { store, storage, waveform, media, density, idleMs });
    this.tasks = new Map();
  }
  get size() { return this.tasks.size; }
  has(id) { return this.tasks.has(id); }
  snapshot() { return [...this.tasks].map(([id, { control }]) => ({ id, updated: control.updated })); }
  async delete(id, { signal } = {}) {
    if (this.has(id)) throw new Error('这份素材正在删除，请等待完成。');
    const control = new DeletionControl({ idleMs: this.idleMs, signal });
    const task = { control, done: null };
    this.tasks.set(id, task);
    task.done = this.remove(id, control).finally(() => {
      this.tasks.delete(id);
      control.close();
    });
    return control.respond(task.done);
  }
  async remove(id, control) {
    const { store, storage, waveform, media, density } = this;
    let storageBlocked = false, waveformBlocked = false, mediaBlocked = false;
    try {
      storageBlocked = true; await control.wait(storage.blockSession(id));
      waveformBlocked = true; await control.wait(waveform.cancelSession(id));
      mediaBlocked = true; await control.wait(media.cancelPreviews(id));
      await control.wait(storage.waitForSession(id));
      return await store.deleteSession(id, true, { control });
    } finally {
      density.drop(id);
      if (waveformBlocked) waveform.allowSession(id);
      if (storageBlocked) storage.allowSession(id);
      if (mediaBlocked) media.allowSession(id);
    }
  }
  async close() {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.control.stop();
    await Promise.allSettled(tasks.map(task => task.done));
  }
}
