import {XiaohongshuH5Chat} from './xiaohongshu-h5-chat.js';
import {XiaohongshuSocketChat} from './xiaohongshu-socket-chat.js';

// A credential change reattaches chat to the existing XML writer. Video and
// its source identity never enter this switch.
export class XiaohongshuChat {
  constructor({session, ...options} = {}) {
    this.session = session;
    this.fallback = new XiaohongshuH5Chat(options);
    this.socket = session ? new XiaohongshuSocketChat({session, ...options}) : null;
    this.clients = new Map();
    this.closed = false;
  }
  mode() { return this.session?.cookie() ? this.socket : this.fallback; }
  start(key, details, callbacks) {
    if (this.closed || this.clients.has(key) || this.clients.size >= 64) throw Error('小红书弹幕服务暂时不可用。');
    const client = {details, callbacks, mode: this.mode(), pending: Promise.resolve()};
    this.clients.set(key, client);
    client.mode.start(key, details, callbacks);
  }
  snapshot(key) { return this.clients.get(key)?.mode.snapshot(key) || null; }
  setRateLimit(value) { this.socket?.setRateLimit(value); }
  update(key, _details, {reauthenticate = false} = {}) {
    if (!reauthenticate) return;
    const client = this.clients.get(key);
    if (!client || this.closed) return;
    client.pending = client.pending.catch(() => {}).then(async () => {
      await client.mode.stop(key);
      if (this.closed || this.clients.get(key) !== client) return;
      client.mode = this.mode();
      client.mode.start(key, client.details, client.callbacks);
    }).catch(() => { client.callbacks.status('retry'); });
  }
  async stop(key) {
    const client = this.clients.get(key);
    if (!client) return;
    this.clients.delete(key);
    await client.pending;
    await client.mode.stop(key);
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.clients.keys()].map(key => this.stop(key)));
    await Promise.all([this.fallback.close(), this.socket?.close()]);
  }
}
