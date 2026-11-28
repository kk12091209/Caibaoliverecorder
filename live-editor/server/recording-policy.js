import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {POLICY_FILES, POLICY_LIMIT, policyUid, readRecordingPolicy} from '../shared/recording-policy.js';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const localDay = ms => new Date(ms).toDateString();
export const recordingRestricted = '该主播已被限制录制。';
export const recordingIdentityPending = '暂未确认主播账号，稍后重试。';

export class RecordingPolicy {
  constructor(store, {channel, fetcher=fetch, now=Date.now, publicKey} = {}) {
    Object.assign(this, {store, channel, fetcher, now, publicKey});
    this.coreFile = path.join(store.root, 'bilibili-recording-policy.json');
    this.entries = new Map();
    this.abort = new AbortController();
  }
  hasRules(platform) { return !!this.entries.get(platform)?.size; }
  blocked(platform, uid) { return this.entries.get(platform)?.has(policyUid(platform, uid)) ?? false; }
  assertAllowed(platform, uid) {
    if (this.blocked(platform, uid)) throw new Error(recordingRestricted);
    if (this.hasRules(platform) && !policyUid(platform, uid)) throw new Error(recordingIdentityPending);
  }
  stateKey(channel) { return 'recording-policy:' + channel; }
  removed(name) { this.notice = '已按录制规则移除监控：' + name; }
  async apply(channel, policy) {
    const entries = new Map();
    for (const {platform,uid} of policy?.entries ?? []) {
      if (!entries.has(platform)) entries.set(platform, new Set());
      entries.get(platform).add(uid);
    }
    const temporary = this.coreFile + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify([...(entries.get('bilibili') ?? [])]), {flag:'wx', mode:0o600});
      await fs.rename(temporary, this.coreFile);
    } finally { await fs.rm(temporary, {force:true}); }
    this.entries = entries;
    this.activeChannel = channel;
    this.revision = policy?.revision ?? 0;
  }
  cached(channel, saved) {
    try { return readRecordingPolicy(saved?.envelope, channel, this.publicKey); }
    catch { return null; }
  }
  async restore() {
    const channel = this.channel();
    await this.apply(channel, this.cached(channel, this.store.setting(this.stateKey(channel))));
  }
  start() {
    if (this.timer || this.abort.signal.aborted) return;
    this.timer = setInterval(() => void this.check(), 60_000);
    this.timer.unref?.();
    void this.check();
  }
  check({force=false} = {}) {
    if (this.abort.signal.aborted) return Promise.resolve(this.snapshot());
    return this.pending ??= this.refresh(force).catch(error => {
      if (!this.abort.signal.aborted) {
        this.error = '暂时无法同步录制规则，沿用上次校验通过的名单。';
        this.store.diagnostics?.record('录制规则', error, {level:'警告'});
      }
    }).then(() => this.snapshot()).finally(() => { this.pending = null; });
  }
  async refresh(force) {
    const channel = this.channel(), key = this.stateKey(channel), now = this.now();
    const saved = this.store.setting(key) ?? {};
    const cached = this.cached(channel, saved);
    if (channel !== this.activeChannel) await this.apply(channel, cached);
    const checkedAt = saved.checkedAt ?? 0;
    if (!force && checkedAt <= now && now - checkedAt < FOUR_HOURS && localDay(checkedAt) === localDay(now)) return;
    if (!force && this.lastAttempt?.channel === channel && now - this.lastAttempt.at < 15 * 60_000) return;
    this.lastAttempt = {channel,at:now};
    const response = await this.fetcher('https://caibao.media/releases/' + POLICY_FILES[channel], {
      signal:AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]), redirect:'error',
      headers:cached && saved.etag ? {'If-None-Match':saved.etag, 'Cache-Control':'no-cache'} : {'Cache-Control':'no-cache'},
    });
    if (this.abort.signal.aborted || this.channel() !== channel) { await response.body?.cancel(); return; }
    if (response.status === 304 && cached) {
      this.store.setting(key, {...saved,checkedAt:now}); this.error = ''; return;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('录制规则请求失败：' + response.status); }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > POLICY_LIMIT + 1024) throw new Error('录制规则文件过大。');
      chunks.push(chunk);
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const policy = readRecordingPolicy(envelope, channel, this.publicKey);
    if (cached && (policy.revision < cached.revision ||
        policy.revision === cached.revision && envelope.data !== saved.envelope.data)) {
      throw new Error('官网返回了旧版或冲突的录制规则。');
    }
    if (this.abort.signal.aborted || this.channel() !== channel) return;
    if (this.revision !== policy.revision) await this.apply(channel, policy);
    this.store.setting(key, {envelope,etag:response.headers.get('etag')||'',checkedAt:now});
    this.error = '';
  }
  snapshot() {
    return {channel:this.activeChannel, revision:this.revision ?? 0,
      checkedAt:this.store.setting(this.stateKey(this.activeChannel))?.checkedAt ?? 0,
      error:this.error ?? '',notice:this.notice ?? ''};
  }
  async close() {
    clearInterval(this.timer);
    this.abort.abort();
    await this.pending;
  }
}
