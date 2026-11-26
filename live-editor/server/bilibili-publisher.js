import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Agent } from 'node:https';
import path from 'node:path';
import { checkedFile, fingerprint, inside, pathKey } from './storage-files.js';
import { normalizePublicationTags } from '../shared/publication-tags.js';
import { MiB, PublicationBandwidth } from './publication-bandwidth.js';

function uploadConfig(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) {
    throw new Error('请填写 1 至 80 个字符的投稿标题。');
  }
  if (typeof input.desc !== 'string' || input.desc.length > 2000 || input.desc.includes('\0')) {
    throw new Error('投稿简介最多 2000 个字符。');
  }
  // An automatic task may contain tags saved before the per-tag limit was added.
  const tags = normalizePublicationTags(input.tag, { legacy: true });
  if (!Number.isSafeInteger(input.tid) || input.tid <= 0 || input.tid > 999999999) {
    throw new Error('请填写有效的 B站投稿分区。');
  }
  if (![1, 2].includes(input.copyright)) throw new Error('请选择自制或转载。');
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (input.copyright === 2 && (!source || source.length > 200 || /[\x00-\x1f\x7f]/.test(source))) {
    throw new Error('转载稿件需要填写 200 个字符以内的来源。');
  }
  for (const flag of [input.dolby, input.hires]) {
    if (flag !== undefined && flag !== 0 && flag !== 1) throw new Error('投稿音频选项无效。');
  }
  return {
    title, desc: input.desc, tag: tags.join(','), tid: input.tid,
    copyright: input.copyright, ...(input.copyright === 2 ? { source } : {}),
    dolby: input.dolby ?? 0, lossless_music: input.hires ?? 0,
  };
}

function videoParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 2) throw new Error('请选择要投稿的成片版本。');
  return parts.map(part => {
    if (typeof part?.path !== 'string' || !path.isAbsolute(part.path) || !/\.mp4$/i.test(part.path) || /[\x00-\x1f\x7f]/.test(part.path)) {
      throw new Error('投稿成片路径无效。');
    }
    const title = typeof part.title === 'string' ? part.title.trim() : '';
    if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('投稿分 P 标题无效。');
    return { path: part.path, title, identity: part.identity };
  });
}

const embeddedTarget = 'embedded';
const unknownSubmission = '无法确认 B站是否已收到稿件，请先在 B站创作中心核对。';
const cookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4']);
const httpsAgent = new Agent({ rejectUnauthorized: true });
const rejectedDraft = new Set([123008, 123009, 123010, 123012, 123013, 123014, 123016, 123017, 123018,
  123022, 123024, 123029, 123030, 123033, 123050, 123051]);
const validId = value => typeof value === 'string' && /^[a-z0-9-]{1,128}$/i.test(value);
const numericId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const categoryLifetime = 15 * 60 * 1000;
const receiptMaxAge = 15 * 60 * 1000;
function validPartReceipt(value) {
  return numericId(value?.cid) && typeof value.filename === 'string' && /^[\w-]{1,256}$/.test(value.filename);
}
const networkCodes = new Set(['ECONNABORTED','ECONNRESET','ETIMEDOUT','EPIPE','EAI_AGAIN','ENETUNREACH','ECONNREFUSED','ENOTFOUND']);
function uploadFailure(error, sdk) {
  const networkCode = error?.cause?.code ?? error?.code;
  const isPlatform = typeof sdk?.BiliResponseError === 'function' && error instanceof sdk.BiliResponseError;
  const status = Number(error?.statusCode ?? error?.response?.status);
  const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const platformCode = isPlatform && Number.isSafeInteger(error.code) ? error.code : null;
  const network = networkCodes.has(networkCode) ? networkCode : null;
  return {code:network || (platformCode !== null ? 'B站 '+platformCode : http !== null ? 'HTTP '+http : ''),
    transient:!!network || http === 408 || http === 429 || http >= 500};
}
const categoryUnavailable = '暂时无法读取 B站投稿分区，请检查网络后重试。';

function categoryOption(value) {
  const id = String(value?.id ?? '');
  const name = typeof value?.name === 'string' ? value.name.trim() : '';
  if (value?.show === false || !/^[1-9]\d{0,8}$/.test(id) || !name) return null;
  return { id, name };
}

function archiveCategories(archive) {
  if (!Array.isArray(archive?.typelist)) return [];
  return archive.typelist.flatMap(group => {
    const option = categoryOption(group);
    const children = Array.isArray(group?.children) ? group.children.map(categoryOption).filter(Boolean) : [];
    return option && children.length ? [{ ...option, children }] : [];
  });
}

function loadBundledSdk() {
  const packaged = new URL('./bilibili-upload-sdk.cjs', import.meta.url);
  const development = new URL('../dist-server/bilibili-upload-sdk.cjs', import.meta.url);
  const file = existsSync(packaged) ? packaged : development;
  return import(file).then(module => module.default);
}

function publicationCredentials(raw = '') {
  const input = Object.create(null);
  for (const section of raw.split(';')) {
    const pair = /^([^=]+)=([\x21-\x7e]*)$/.exec(section.trim());
    if (pair && cookieNames.has(pair[1])) input[pair[1]] = pair[2];
  }
  return input;
}

class PublicationError extends Error {}
const denied = new PublicationError('该投稿任务已停止。');

function definiteRejection(error, sdk) {
  if (typeof sdk?.BiliResponseError !== 'function' || !(error instanceof sdk.BiliResponseError)) return '';
  if (error.code === -101 || error.code === -111) return 'B站 Cookie 已失效，请在设置中更新后重试。';
  if (error.statusCode === 406 || error.code === 123050 || error.code === 123051) {
    return 'B站要求完成投稿验证，请到 B站创作中心处理后重试。';
  }
  if (rejectedDraft.has(error.code)) return 'B站拒绝了这次投稿，请检查分区、标签、稿件信息及账号权限。';
  return '';
}

function requestOptions(request, signal, timeout) {
  if (request?.defaults) Object.assign(request.defaults, { signal, timeout, maxRedirects: 0, httpsAgent });
}

function untilAbort(signal, work) {
  signal.throwIfAborted();
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Some upload SDK retries wait on timers even after their requests stop.
    // Stop awaiting them on close, while continuing to handle late rejection.
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject);
  }).finally(() => signal.removeEventListener('abort', abort));
}

export class BilibiliPublisher {
  #active = null;
  #sdk;
  #categoryCatalog;
  #closed = false;

  constructor(store, credentials, { loadSdk = loadBundledSdk, bandwidth = new PublicationBandwidth() } = {}) {
    Object.assign(this, { store, credentials, loadSdk, bandwidth });
  }

  async initialize() {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS bilibili_publisher_jobs (
      id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, uid TEXT NOT NULL,
      config TEXT NOT NULL, parts TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      aid TEXT NOT NULL DEFAULT '', bvid TEXT NOT NULL DEFAULT '', can_retry INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS bilibili_publisher_pending ON bilibili_publisher_jobs(status);
    UPDATE bilibili_publisher_jobs SET status='queued' WHERE status='uploading';`);
    const columns = this.store.db.prepare('PRAGMA table_info(bilibili_publisher_jobs)').all();
    if (!columns.some(column => column.name === 'checkpoint')) {
      this.store.db.exec("ALTER TABLE bilibili_publisher_jobs ADD COLUMN checkpoint TEXT NOT NULL DEFAULT '{}'");
    }
    this.store.run("UPDATE bilibili_publisher_jobs SET status='uncertain',error=? WHERE status='submitting'", unknownSubmission);
    return this;
  }

  snapshot() {
    const state = this.credentials.snapshot().platforms.bilibili;
    const cookie = publicationCredentials(this.credentials.get('bilibili'));
    const accountUid = numericId(cookie.DedeUserID) ? cookie.DedeUserID : '';
    const configured = !!(state.configured && !state.expired && accountUid && cookie.SESSDATA && cookie.bili_jct);
    let error = '';
    if (!state.configured) error = '请先在设置中填写 B站 Cookie。';
    else if (state.expired) error = 'B站 Cookie 已失效，请在设置中更新后重试。';
    else if (!accountUid || !cookie.SESSDATA) error = 'B站 Cookie 当前不可用，请在设置中检查。';
    else if (!cookie.bili_jct) error = '请在设置中重新复制完整的 B站 Cookie，投稿需要包含 bili_jct。';
    return { configured, cookieConfigured: state.configured === true, accountUid, accountError: error };
  }

  async account() {
    const status = this.snapshot();
    if (!status.configured) throw new PublicationError(status.accountError);
    return { uid: status.accountUid, name: '' };
  }

  async categories(uid) {
    const account = await this.account();
    if (uid !== undefined && account.uid !== uid) throw new PublicationError('B站投稿账号已改变，请重新打开设置。');
    const raw = this.credentials.get('bilibili');
    let cached = this.#categoryCatalog;
    if (!cached || cached.raw !== raw || cached.expires <= Date.now()) {
      cached = { raw, expires: Infinity };
      this.#categoryCatalog = cached;
      cached.result = this.readCategories(raw, account.uid).then(categories => {
        cached.expires = Date.now() + categoryLifetime;
        return categories;
      }).catch(error => {
        if (this.#categoryCatalog === cached) this.#categoryCatalog = undefined;
        throw error;
      });
    }
    const categories = await cached.result;
    if (raw !== this.credentials.get('bilibili') || !this.snapshot().configured) {
      throw new PublicationError('B站 Cookie 或投稿账号已改变，请重新打开设置。');
    }
    return categories;
  }

  async readCategories(raw, uid) {
    const signal = AbortSignal.timeout(8000);
    try {
      const sdk = this.#sdk ??= await untilAbort(signal, () => this.loadSdk());
      const client = new sdk.Client();
      await client.setAuth(publicationCredentials(raw), Number(uid));
      const platform = client.platform;
      requestOptions(platform.request, signal, 8000);
      const categories = archiveCategories(await untilAbort(signal, () => platform.getArchivePre()));
      if (categories.length) return categories;
    } catch (error) {
      throw new PublicationError(definiteRejection(error, this.#sdk) || categoryUnavailable);
    }
    throw new PublicationError(categoryUnavailable);
  }

  async assertCategory(categoryId, uid) {
    const categories = await this.categories(uid);
    if (!categories.some(group => group.children.some(option => option.id === String(categoryId)))) {
      throw new PublicationError('该 B站投稿分区不可选，请重新选择分区。');
    }
  }

  async fileIdentity(file) {
    if (['originals', 'archives', 'chunks', 'temp', 'profile', 'runtime', 'private-credentials'].some(folder =>
      inside(path.join(this.store.root, folder), file))) {
      throw new PublicationError('投稿只能使用已导出的成片。');
    }
    const stat = await checkedFile(path.dirname(file), file).catch(() => null);
    if (!stat || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PublicationError('投稿成片已移动、修改或删除，请检查后重新导出。');
    }
    return { identity: fingerprint(stat), bytes: Number(stat.size) };
  }

  async submit({ owner, uid, config, parts, beforeSend }) {
    if (!['auto', 'quick'].includes(owner?.kind) || !validId(owner.id)) throw new Error('投稿任务来源无效。');
    const account = await this.account();
    if (String(uid) !== account.uid) throw new PublicationError('B站投稿账号已改变，请重新核对。');
    const videos = videoParts(parts);
    if (new Set(videos.map(part => pathKey(part.path))).size !== videos.length) throw new Error('投稿成片路径重复。');
    const metadata = uploadConfig(config);
    for (const part of videos) {
      const receipt = await this.fileIdentity(part.path);
      if (part.identity !== undefined && part.identity !== receipt.identity) {
        throw new PublicationError('投稿成片已发生变化，请检查后重新导出。');
      }
      Object.assign(part, receipt);
    }
    await this.assertCategory(metadata.tid, account.uid);
    const current = this.snapshot();
    if (!current.configured || current.accountUid !== account.uid) throw new PublicationError('B站投稿账号已改变，请重新核对。');
    if (this.#closed) throw new PublicationError('程序正在退出，请稍后重试。');
    beforeSend?.();
    const taskId = randomUUID();
    // A task is armed only after its caller has saved the receipt. An orphan
    // left by a crash between those writes can never submit a Bilibili draft.
    const previous = this.store.get(`SELECT id,uid,parts,status,checkpoint FROM bilibili_publisher_jobs
      WHERE owner_kind=? AND owner_id=? ORDER BY rowid DESC LIMIT 1`, owner.kind, owner.id);
    const partsJson = JSON.stringify(videos);
    const checkpoint = previous?.status === 'failed' && previous.uid === account.uid && previous.parts === partsJson
      ? JSON.parse(previous.checkpoint) : {};
    this.store.run(`INSERT INTO bilibili_publisher_jobs(id,owner_kind,owner_id,uid,config,parts,status,checkpoint)
      VALUES(?,?,?,?,?,?,'staged',?)`, taskId, owner.kind, owner.id, account.uid, JSON.stringify(metadata), partsJson,
    JSON.stringify({parts:checkpoint.parts, previous:previous?.id}));
    this.log({id:taskId,owner_kind:owner.kind,owner_id:owner.id},
      `已获得本地任务编号${previous ? '；上次 '+previous.id : ''}`);
    return { taskId, target: embeddedTarget };
  }

  async task(taskId, target) {
    if (!validId(taskId) || (target && target !== embeddedTarget)) throw this.taskMissing();
    if (!this.#closed) this.store.run("UPDATE bilibili_publisher_jobs SET status='queued' WHERE id=? AND status='staged'", taskId);
    const row = this.store.get('SELECT status,error,aid,bvid,can_retry FROM bilibili_publisher_jobs WHERE id=?', taskId);
    if (!row) throw this.taskMissing();
    const active = this.#active?.id === taskId ? this.#active : null;
    const transfer = ['queued','uploading'].includes(row.status) ? this.transferStatus(taskId) : undefined;
    return {
      status: row.status === 'staged' ? 'queued' : row.status,
      progress: row.status === 'submitted' ? 1 : active?.progress ?? 0, ...(transfer ? {transfer} : {}),
      ...(row.error ? { error: row.error } : {}), ...(row.aid ? { aid: row.aid } : {}),
      ...(row.bvid ? { bvid: row.bvid } : {}), canRetry: row.can_retry === 1,
    };
  }

  taskMissing() {
    return Object.assign(new Error('在本机找不到这条投稿任务。'), { taskMissing: true });
  }

  hasWork() {
    return !this.#closed && !!(this.#active || this.store.get(
      "SELECT 1 FROM bilibili_publisher_jobs WHERE status IN ('queued','uploading','submitting') LIMIT 1"));
  }

  transferStatus(taskId) {
    const active = this.#active;
    if (!taskId) return undefined;
    if (active?.id !== taskId || !active.transfer) return this.bandwidth.rate===0 ? this.bandwidth.snapshot() : undefined;
    const { bytesPerSecond } = active.transfer.metrics();
    return { ...this.bandwidth.snapshot(), bytesPerSecond, part: active.part, parts: active.parts, progress: active.progress };
  }

  updateRecording(evidence) {
    const active = this.#active;
    if (active && !active.committing && !active.controller.signal.aborted) {
      const account=this.snapshot(),authorized=active.authorized();
      if (!authorized || !account.configured || account.accountUid !== active.row.uid) {
        active.cancelReason = !authorized ? denied : new PublicationError('B站 Cookie 或投稿账号已改变，请在设置中检查。');
        active.controller.abort();
        active.cancelUpload?.();
      }
    }
    if (this.bandwidth.update(evidence, active?.transfer?.metrics().bytesPerSecond) && active) {
      const { state, limitBytesPerSecond, reason, room } = this.bandwidth.snapshot();
      const rate = limitBytesPerSecond === null ? '全速' : (limitBytesPerSecond / MiB).toFixed(2) + ' MiB/s';
      this.log(active.row, ['上传调速 '+state, rate, reason, room&&'房间 '+room].filter(Boolean).join('；'), '信息', true);
    }
  }

  tick(authorize, { automaticAllowed = true } = {}) {
    if (this.#closed) return;
    if (this.#active) return this.#active.done;
    if (this.bandwidth.rate === 0) return;
    const row = this.store.get("SELECT * FROM bilibili_publisher_jobs WHERE status='queued' AND (? OR owner_kind<>'auto') ORDER BY rowid LIMIT 1", +automaticAllowed);
    if (!row) return;
    const controller = new AbortController();
    const active = { id: row.id, row, controller, progress: 0, cancelUpload: null, committing: false, automatic: row.owner_kind === 'auto',
      authorized: () => authorize?.({ kind: row.owner_kind, id: row.owner_id }, row.uid, row.id) === true };
    this.#active = active;
    active.done = this.run(row, active, authorize).finally(() => { this.#active = null; });
    return active.done;
  }

  async verifyAccount(row, signal) {
    const raw = this.credentials.get('bilibili');
    const cookie = publicationCredentials(raw);
    if (cookie.DedeUserID !== row.uid || !this.snapshot().configured) {
      throw new PublicationError('B站 Cookie 或投稿账号已改变，请在设置中检查。');
    }
    const sdk = this.#sdk ??= await this.loadSdk().catch(() => {
      throw new PublicationError('B站投稿组件无法加载，请检查软件安装。');
    });
    signal.throwIfAborted();
    const client = new sdk.Client();
    await client.setAuth(cookie, Number(row.uid));
    const user = client.user;
    requestOptions(user.request, signal, 8000);
    let info;
    try {
      info = await untilAbort(signal, () => user.getMyInfo());
    } catch (error) {
      throw new PublicationError(definiteRejection(error, sdk) || '暂时无法核对 B站账号，请检查网络和 Cookie。');
    }
    if (!numericId(info?.profile?.mid) || String(info.profile.mid) !== row.uid || raw !== this.credentials.get('bilibili')) {
      throw new PublicationError('B站返回的账号与当前投稿账号不同，请检查 Cookie。');
    }
    return { client, raw };
  }

  async checkFiles(parts) {
    for (const part of parts) {
      const stat = await this.fileIdentity(part.path);
      if (stat.identity !== part.identity || stat.bytes !== part.bytes) {
        throw new PublicationError('投稿成片已发生变化，请检查后重新导出。');
      }
    }
  }

  log(row, message, level = '信息', important = false) {
    const diagnostics = this.store.diagnostics;
    if (!diagnostics) return;
    const source = row.owner_kind === 'auto'
      ? this.store.get('SELECT room,export_job FROM auto_post_jobs WHERE session=?', row.owner_id)
      : this.store.get('SELECT session,id AS export_job FROM jobs WHERE id=?', row.owner_id);
    const context = [source?.room && '房间 '+source.room, source?.session && '录像 '+source.session,
      source?.export_job && '导出 '+source.export_job].filter(Boolean);
    diagnostics.record('B站投稿',
      `${row.owner_kind === 'quick' ? '快速发布' : '自动投稿录像'} ${row.owner_id}；${[...context,'尝试 '+row.id,message].join('；')}`,
      {level, important});
  }

  async run(row, active, authorize) {
    const signal = active.controller.signal;
    const guard = () => {
      signal.throwIfAborted();
      if (authorize?.({ kind: row.owner_kind, id: row.owner_id }, row.uid, row.id) !== true) throw denied;
    };
    const checkpoint = JSON.parse(row.checkpoint || '{}');
    const receipts = checkpoint.parts || [];
    const persistReceipts = () => this.store.run('UPDATE bilibili_publisher_jobs SET checkpoint=? WHERE id=?',
      JSON.stringify({...checkpoint, parts:receipts}), row.id);
    let stage = '检查成片';
    const start = Date.now();
    try {
      guard();
      this.save(row.id, 'uploading');
      this.log(row, '开始处理');
      const parts = JSON.parse(row.parts);
      const config = JSON.parse(row.config);
      await this.checkFiles(parts);
      stage = '核对投稿账号';
      let verified = await this.verifyAccount(row, signal);
      const completed = [];
      let uploadedBytes = 0;
      const total = parts.reduce((sum, part) => sum + part.bytes, 0);
      for (const [index, part] of parts.entries()) {
        stage = `上传 P${index+1}`;
        await this.checkFiles([part]);
        if (verified.raw !== this.credentials.get('bilibili')) verified = await this.verifyAccount(row, signal);
        guard();
        if (verified.raw !== this.credentials.get('bilibili') || !this.snapshot().configured) {
          throw new PublicationError('B站 Cookie 或投稿账号已改变，请在设置中检查。');
        }
        const cached = receipts[index];
        if (validPartReceipt(cached) && Number.isSafeInteger(cached.at) && Date.now() >= cached.at &&
            Date.now()-cached.at < receiptMaxAge) {
          completed.push({cid:cached.cid,filename:cached.filename,title:part.title});
          uploadedBytes += part.bytes;
          active.progress = uploadedBytes / total * 0.99;
          this.log(row, `P${index+1} 复用已上传分 P；${part.bytes} 字节`, '信息', true);
          continue;
        }
        const partStart = Date.now();
        this.log(row, `P${index+1} 开始上传；${part.bytes} 字节`);
        const transfer = this.bandwidth.transfer();
        Object.assign(active, { transfer, part: index + 1, parts: parts.length });
        const upload = new this.#sdk.WebVideoUploader({ path: part.path, title: part.title }, verified.client.auth, {
          concurrency: active.automatic ? 1 : 2, bandwidth: {
            ...transfer,
            confirm: (chunk, bytes) => {
              transfer.confirm(chunk, bytes);
              active.progress = (uploadedBytes + transfer.metrics().confirmed) / total * .99;
            },
          },
          retryTimes: 2, retryDelay: 750,
        });
        requestOptions(upload.request, signal, active.automatic ? 90000 : 12000);
        active.cancelUpload = () => upload.cancel();
        upload.on('error', () => {});
        let result;
        try {
          result = await untilAbort(signal, () => upload.upload());
        } finally {
          const elapsed = Date.now() - partStart;
          const { emitted, repeated, pausedMs } = transfer.metrics();
          this.log(row, `P${index+1} 发送 ${emitted} 字节；均速 ${(emitted*1000/Math.max(1,elapsed)/MiB).toFixed(2)} MiB/s；重传 ${repeated} 字节；保护等待 ${pausedMs} ms`);
          active.transfer = null;
        }
        active.cancelUpload = null;
        guard();
        if (!validPartReceipt(result)) {
          throw new PublicationError('B站未返回有效的分 P 上传结果，请重试。');
        }
        const receipt = {cid:Number(result.cid), filename:result.filename, at:Date.now()};
        receipts[index] = receipt;
        persistReceipts();
        active.progress = (uploadedBytes + part.bytes) / total * .99;
        this.log(row, `P${index+1} 上传完成；${part.bytes} 字节；耗时 ${Date.now()-partStart} ms`);
        completed.push({cid:receipt.cid,filename:receipt.filename,title:part.title});
        uploadedBytes += part.bytes;
        active.progress = uploadedBytes / total * 0.99;
      }
      await this.checkFiles(parts);
      // Renew the account check after a potentially long transfer. Re-select
      // the current saved credentials and never finalize under a changed UID.
      stage = '提交前核对账号';
      const final = await this.verifyAccount(row, signal);
      guard();
      if (final.raw !== this.credentials.get('bilibili') || !this.snapshot().configured) {
        throw new PublicationError('B站 Cookie 或投稿账号已改变，请在设置中检查。');
      }
      const platform = final.client.platform;
      requestOptions(platform.request, signal, 20000);
      stage = '提交稿件';
      this.save(row.id, 'submitting');
      this.log(row, stage, '信息', true);
      active.committing = true;
      const result = await untilAbort(signal, () => platform.addMediaWebApiV3(completed, config));
      const aid = numericId(result?.aid) ? String(result.aid) : '';
      const bvid = typeof result?.bvid === 'string' && /^BV[\da-zA-Z]{10}$/.test(result.bvid) ? result.bvid : '';
      if (!aid && !bvid) {
        this.save(row.id, 'uncertain', unknownSubmission);
        this.log(row, unknownSubmission, '警告', true);
      } else {
        this.save(row.id, 'submitted', '', false, aid, bvid);
        this.log(row, `已收到稿件回执 ${bvid||aid}；耗时 ${Date.now()-start} ms`, '信息', true);
      }
    } catch (error) {
      const failure = uploadFailure(error, this.#sdk);
      const detail = `${stage}${failure.code ? '（'+failure.code+'）' : ''}`;
      if (active.committing || (!signal.aborted && !failure.transient && !stage.startsWith('核对'))) {
        receipts.length = 0;
        persistReceipts();
      }
      if (active.committing) {
        const rejected = definiteRejection(error, this.#sdk);
        if (rejected) this.save(row.id, 'failed', rejected, true);
        else this.save(row.id, 'uncertain', unknownSubmission);
      } else if (active.cancelReason === denied) this.save(row.id, 'cancelled', denied.message);
      else if (active.cancelReason) this.save(row.id, 'failed', active.cancelReason.message, true);
      else if (signal.aborted) this.save(row.id, 'queued');
      else if (error === denied) this.save(row.id, 'cancelled', error.message);
      else this.save(row.id, 'failed', `${detail}：${error instanceof PublicationError ? error.message :
        definiteRejection(error, this.#sdk) || 'B站视频上传失败，成片已保留，可重试。'}`, true);
      const outcome = this.store.get('SELECT status,error FROM bilibili_publisher_jobs WHERE id=?', row.id);
      this.log(row, `${detail}；${outcome.status}${outcome.error ? '；'+outcome.error : '；已让位'}；耗时 ${Date.now()-start} ms`,
        outcome.status === 'queued' ? '信息' : '警告', true);
    } finally {
      active.cancelUpload = null;
    }
  }

  save(id, status, error = '', retry = false, aid = '', bvid = '') {
    this.store.run('UPDATE bilibili_publisher_jobs SET status=?,error=?,can_retry=?,aid=?,bvid=? WHERE id=?',
      status, error, Number(retry), aid, bvid, id);
  }

  async close() {
    this.#closed = true;
    const active = this.#active;
    if (!active) return;
    active.controller.abort();
    active.cancelUpload?.();
    await active.done;
  }
}
