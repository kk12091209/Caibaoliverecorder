import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {xhsError} from './xiaohongshu-protocol.js';

// A private browser process communicates through inherited pipes. No debugging
// port is opened and no existing browser profile is read.
export class XhsBrowserPipe extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.bytes = Buffer.alloc(0);
    this.closed = false;
    child.stdio[4].on('data', bytes => this.read(bytes));
    child.stdio[3].on('error', () => this.finish());
    child.stdio[4].on('error', () => this.finish());
    child.on('error', () => this.finish());
    child.on('exit', () => this.finish());
    child.stderr?.resume();
  }

  read(bytes) {
    if (this.closed) return;
    if (this.bytes.length + bytes.length > 4 * 1024 * 1024) return this.finish();
    this.bytes = Buffer.concat([this.bytes, bytes]);
    for (;;) {
      const end = this.bytes.indexOf(0);
      if (end < 0) return;
      let message;
      try { message = JSON.parse(this.bytes.subarray(0, end).toString('utf8')); }
      catch { return this.finish(); }
      this.bytes = this.bytes.subarray(end + 1);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) pending.complete(message.error ? xhsError('browser', '小红书网页会话暂时不可用。') : null, message.result);
      } else if (typeof message.method === 'string') this.emit('event', message);
    }
  }

  send(method, params = {}, sessionId, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(signal?.reason || xhsError('browser', '小红书网页会话已关闭。'));
    if (this.pending.size >= 128) return Promise.reject(xhsError('browser', '小红书网页会话繁忙。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const complete = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => complete(signal.reason);
      const timer = setTimeout(() => complete(xhsError('timeout', '小红书网页请求超时。')), 10000);
      this.pending.set(id, {complete});
      signal?.addEventListener('abort', abort, {once: true});
      const value = {id, method, params, ...(sessionId ? {sessionId} : {})};
      this.child.stdio[3].write(JSON.stringify(value) + '\0', error => { if (error) this.finish(); });
    });
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.bytes = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.complete(xhsError('browser', '小红书网页会话已断开。'));
    this.child.kill();
    this.emit('closed');
  }

  async close() {
    if (this.closed) return;
    await this.send('Browser.close').catch(() => {});
    this.finish();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

export async function xhsBrowserExecutable() {
  const windows = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).flatMap(root => [path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  const candidates = [process.env.CAIBO_XHS_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', ...windows];
  for (const candidate of candidates.filter(Boolean)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch { /* Check the next locally installed browser. */ }
  }
  throw xhsError('browser', '小红书弹幕与开播识别需要本机 Chrome 或 Edge。');
}

export async function launchXhsBrowser(root, {launch = spawn, executable = xhsBrowserExecutable} = {}) {
  const binary = await executable();
  const temporary = path.join(root, 'temp');
  await fs.mkdir(temporary, {recursive: true});
  const directory = await fs.mkdtemp(path.join(temporary, 'xhs-browser-'));
  let connection;
  try {
    const child = launch(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-extensions', '--disable-background-timer-throttling',
      '--autoplay-policy=user-gesture-required', '--remote-debugging-pipe', '--user-data-dir=' + directory,
      'about:blank'], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Keep the process usable when the host refuses a priority change. */ }
    connection = new XhsBrowserPipe(child);
    await connection.send('Browser.getVersion');
    const close = connection.close.bind(connection);
    connection.close = async () => {
      await close();
      await fs.rm(directory, {recursive: true, force: true}).catch(() => {});
    };
    return connection;
  } catch (error) {
    await connection?.close();
    await fs.rm(directory, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}
