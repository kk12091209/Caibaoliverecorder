import {ChatIntake} from './chat-intake.js';
import {xhsComments, XHS_UID} from './xiaohongshu-protocol.js';

export class XiaohongshuSocketChat {
  constructor({session, now = Date.now, retryMs = 30000, flushMs = 250} = {}) {
    Object.assign(this, {session, now, retryMs, flushMs});
    this.intake = new ChatIntake({now, validSenderId: id => XHS_UID.test(id || '')});
    this.clients = new Map();
    this.closed = false;
  }

  setRateLimit(value) { this.intake.setRateLimit(value); }
  snapshot(key) {
    const client = this.clients.get(key);
    return client ? {connection: client.connection, error: client.error,
      writeFailed: client.writeFailed, written: client.written} : null;
  }

  start(key, details, callbacks) {
    if (this.closed || this.clients.has(key) || this.clients.size >= 64) throw Error('小红书弹幕服务暂时不可用。');
    const client = {details, callbacks, abort: new AbortController(), connection: 'connecting',
      error: '', writeFailed: false, written: false, writeRetryAt: 0};
    this.clients.set(key, client);
    this.intake.start(key, {start: details.sourceStart});
    client.flusher = setInterval(() => { void this.flush(key, client); }, this.flushMs);
    void this.connect(key, client);
  }

  async connect(key, client) {
    client.pending = (async () => {
      let lease;
      try {
        lease = await this.session.watchRoom(client.details.roomId, {
          signal: client.abort.signal,
          onStatus: status => {
            if (client.abort.signal.aborted) return;
            client.connection = status;
            if (!client.writeFailed) client.error = '';
            client.callbacks.status(status);
          },
          onFrame: (frame, routing = {}) => {
            if (client.abort.signal.aborted) return;
            const messages = xhsComments(frame, {...client.details, received: this.now(), joinedRoom: routing.joinedRoom});
            for (const message of messages) this.intake.add(key, message);
            if (messages.length) {
              client.connection = 'connected';
              client.callbacks.status('first-comment');
            }
            return messages.length > 0;
          },
        });
        throw await lease.closed;
      } catch (error) {
        if (client.abort.signal.aborted) return;
        client.connection = 'retrying';
        if (!client.writeFailed) client.error = error?.message || '小红书弹幕连接断开，正在重试。';
        client.callbacks.status('retry');
      } finally { await lease?.close(); }
    })();
    await client.pending;
    if (!this.closed && !client.abort.signal.aborted) {
      client.timer = setTimeout(() => { void this.connect(key, client); }, this.retryMs);
    }
  }

  flush(key, client, force = false) {
    if (client.writing) return client.writing;
    if (!force && this.now() < client.writeRetryAt) return Promise.resolve();
    client.writing = (async () => {
      for (;;) {
        client.batch ||= this.intake.take(key, {force});
        if (!client.batch) break;
        try {
          await client.callbacks.write({...client.batch, gifts: []});
          const hasRecords = client.batch.messages.length > 0;
          client.batch.release();
          client.batch = null;
          client.writeFailed = false;
          client.error = '';
          if (hasRecords) { client.written = true; client.callbacks.status('first-write'); }
        } catch {
          client.writeFailed = true;
          client.error = '小红书弹幕保存失败，正在重试。';
          client.writeRetryAt = this.now() + 2000;
          client.callbacks.status('write-failed');
          break;
        }
        if (!force) break;
      }
    })().finally(() => { client.writing = null; });
    return client.writing;
  }

  async stop(key) {
    const client = this.clients.get(key);
    if (!client) return;
    client.abort.abort();
    clearTimeout(client.timer);
    clearInterval(client.flusher);
    await client.pending;
    this.intake.stop(key);
    await client.writing;
    await this.flush(key, client, true);
    client.batch?.release();
    this.intake.drop(key);
    this.clients.delete(key);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.clients.keys()].map(key => this.stop(key)));
  }
}
