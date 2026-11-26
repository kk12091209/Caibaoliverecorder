import { publicationFiles } from './publication-files.js';
import { normalizePublicationTags } from '../shared/publication-tags.js';

const unknownSubmission = '无法确认稿件是否已提交，请在 B站创作中心核对。';
const duplicate = () => Object.assign(new Error('这次导出已有投稿任务。'), { status: 409 });
const controlCharacters = /[\x00-\x1f\x7f]/;

function normalize(input) {
  if (!input || typeof input !== 'object' || !['clean', 'danmaku', 'dual'].includes(input.mode)) {
    throw new Error('请选择要投稿的成片版本。');
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 80 || controlCharacters.test(title)) throw new Error('请填写 1 至 80 个字符的标题。');
  if (typeof input.description !== 'string' || input.description.length > 2000 || input.description.includes('\0')) {
    throw new Error('简介最多 2000 个字符。');
  }
  const tags = normalizePublicationTags(input.tags);
  const categoryId = String(input.categoryId ?? '');
  if (!/^[1-9]\d{0,8}$/.test(categoryId)) throw new Error('请选择 B站投稿分区。');
  const copyright = Number(input.copyright);
  if (![1, 2].includes(copyright)) throw new Error('请选择自制或转载。');
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (copyright === 2 && (!source || source.length > 200 || controlCharacters.test(source))) {
    throw new Error('转载稿件需要填写 200 个字符以内的来源。');
  }
  return { title, description: input.description.trim(), tags, categoryId, copyright,
    source: copyright === 2 ? source : '', mode: input.mode };
}

function publicJob(row, publisher) {
  if (!row) return null;
  const transfer = row.status === 'uploading' ? publisher?.transferStatus?.(row.remote_task) : undefined;
  return {
    id: row.export_job, exportJobId: row.export_job, session: row.session,
    status: row.status, title: row.title, error: row.error,
    progress: transfer?.progress ?? row.progress, transfer, aid: row.aid || undefined, bvid: row.bvid || undefined,
    canRetry: row.status === 'failed' && !row.remote_task,
  };
}

function isSameJob(before, after) {
  return before.session === after.session && before.status === after.status &&
    before.file === after.file && before.mode === after.mode && before.data === after.data;
}

export class QuickPublish {
  constructor(store, publisher) {
    this.store = store;
    this.publisher = publisher;
    this.submissions = new Map();
    this.active = null;
    this.closed = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS quick_publish_jobs(
      export_job TEXT PRIMARY KEY, session TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, form TEXT NOT NULL, remote_task TEXT, progress REAL, aid TEXT, bvid TEXT,
      error TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL
    )`);
    store.run("UPDATE quick_publish_jobs SET status='uncertain',error=? WHERE status='submitting'", unknownSubmission);
  }

  getPublication(id) {
    return this.store.get('SELECT * FROM quick_publish_jobs WHERE export_job=?', id);
  }

  snapshot() {
    return this.store.all('SELECT * FROM quick_publish_jobs ORDER BY updated DESC LIMIT 200').map(row=>publicJob(row,this.publisher));
  }

  isBusy(id) {
    if (this.submissions.has(id)) return true;
    const publication = this.getPublication(id);
    return publication?.status === 'uploading' || publication?.status === 'submitting';
  }

  authorizes(id, uid, taskId) {
    const publication = this.getPublication(id);
    return publication?.status === 'uploading' && publication.uid === uid && publication.remote_task === taskId;
  }

  job(id) {
    const row = this.store.get('SELECT * FROM jobs WHERE id=?', id);
    if (!row || !this.store.session(row.session)) {
      throw Object.assign(new Error('导出任务不存在或已经删除。'), { status: 404 });
    }
    if (row.status !== 'done' || this.store.deletingJobs?.has(id) || this.store.deletions?.has(row.session)) {
      throw new Error('请等待导出完成并保存成片后再投稿。');
    }
    const data = this.store.jobDetails(row);
    if (data.recoveryInvalid || data.autoPost || !['clean', 'danmaku', 'dual'].includes(row.mode)) {
      throw new Error('这项导出无法使用快速发布。');
    }
    return { row, data };
  }

  async details(id) {
    if (!this.publisher.snapshot().cookieConfigured) throw new Error('请先填写 B站 Cookie。');
    const job = this.job(id);
    const previous = this.getPublication(id);
    const files = await publicationFiles(this.store, job.row, job.data);
    if (!files.size && !previous) throw new Error('导出的成片已移动、修改或删除，请重新导出后再投稿。');
    const availableModes = [...files.keys()];
    if (files.size === 2) availableModes.push('dual');
    const session = this.store.session(job.row.session);
    if (!session || !isSameJob(job.row, this.job(id).row)) throw new Error('导出任务已变化，请重新打开。');
    const draft = previous && JSON.parse(previous.form);
    const defaultMode = availableModes.includes(job.row.mode) ? job.row.mode : availableModes[0];
    const title = String(session.title || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
      .slice(0, 80).replace(/[\uD800-\uDBFF]$/, '') || '直播选段';
    const defaults = { title, description: '', tags: [], categoryId: '', copyright: '', source: '' };
    const { accountUid, accountError } = this.publisher.snapshot();
    return { ...defaults, ...draft, availableModes, account: accountUid ? { uid: accountUid } : null, accountError,
      mode: availableModes.includes(draft?.mode) ? draft.mode : defaultMode, publication: publicJob(previous,this.publisher) };
  }

  async submit(id, input) {
    if (this.closed) throw new Error('程序正在退出，请稍后重试。');
    if (this.submissions.has(id)) throw duplicate();
    const submission = this.send(id, input);
    this.submissions.set(id, submission);
    try { return await submission; }
    finally { this.submissions.delete(id); }
  }

  async send(id, input) {
    const draft = normalize(input);
    const uid = String(input.accountUid ?? '');
    const connection = this.publisher.snapshot();
    if (!connection.cookieConfigured || !uid || uid !== String(connection.accountUid)) {
      throw new Error('B站投稿账号已变更，请重新打开快速发布。');
    }
    if (!connection.configured) throw new Error(connection.accountError || 'B站 Cookie 当前不可用。');
    const prior = this.getPublication(id);
    if (prior && (prior.status !== 'failed' || prior.remote_task)) throw duplicate();
    const job = this.job(id);
    const files = await publicationFiles(this.store, job.row, job.data);
    const modes = draft.mode === 'dual' ? ['danmaku', 'clean'] : [draft.mode];
    if (modes.some(mode => !files.has(mode))) throw new Error('选中的成片已移动、修改或删除，请先重新导出。');
    if (!isSameJob(job.row, this.job(id).row)) throw new Error('导出任务已变化，请重新打开。');
    if (this.closed || uid !== String(this.publisher.snapshot().accountUid)) {
      throw new Error('当前投稿账号已变更或程序正在退出，请稍后重试。');
    }
    const result = this.store.run(`INSERT INTO quick_publish_jobs(export_job,session,uid,title,status,form,updated)
      VALUES(?,?,?,?,'submitting',?,?) ON CONFLICT(export_job) DO UPDATE SET uid=excluded.uid,title=excluded.title,
      status='submitting',form=excluded.form,progress=NULL,aid=NULL,bvid=NULL,error='',updated=excluded.updated
      WHERE quick_publish_jobs.status='failed' AND quick_publish_jobs.remote_task IS NULL`,
    id, job.row.session, uid, draft.title, JSON.stringify(draft), Date.now());
    if (!result.changes) throw duplicate();
    let submitted;
    try {
      submitted = await this.publisher.submit({
        uid, owner: { kind: 'quick', id }, parts: modes.map(mode => files.get(mode)),
        config: {
          title: draft.title, desc: draft.description, tag: draft.tags, tid: Number(draft.categoryId),
          copyright: draft.copyright, ...(draft.copyright === 2 ? { source: draft.source } : {}), dolby: 0, hires: 0,
        },
      });
    } catch (error) {
      this.update(id, error.submissionUncertain ? 'uncertain' : 'failed',
        error.submissionUncertain ? unknownSubmission : error.message);
      return { publication: publicJob(this.getPublication(id)) };
    }
    if (typeof submitted?.taskId !== 'string' || !submitted.taskId) {
      this.update(id, 'uncertain', unknownSubmission);
    } else {
      this.store.run("UPDATE quick_publish_jobs SET status='uploading',remote_task=?,updated=? WHERE export_job=?",
        submitted.taskId, Date.now(), id);
    }
    return { publication: publicJob(this.getPublication(id)) };
  }

  update(id, status, error = '', progress = null, aid = '', bvid = '', canRetry = false) {
    this.store.run(`UPDATE quick_publish_jobs SET status=?,error=?,progress=?,aid=?,bvid=?,
      remote_task=CASE WHEN ? THEN NULL ELSE remote_task END,updated=? WHERE export_job=?
      AND (status<>? OR error<>? OR progress IS NOT ? OR aid IS NOT ? OR bvid IS NOT ? OR (? AND remote_task IS NOT NULL))`,
    status, error, progress, aid, bvid, Number(canRetry), Date.now(), id, status, error, progress, aid, bvid, Number(canRetry));
  }

  tick() {
    if (this.closed || this.active) return this.active;
    this.active = this.refresh().finally(() => { this.active = null; });
    return this.active;
  }

  async refresh() {
    const pending = this.store.all("SELECT * FROM quick_publish_jobs WHERE status='uploading' AND remote_task IS NOT NULL");
    for (const row of pending) {
      if (this.closed) break;
      try {
        const result = await this.publisher.task(row.remote_task);
        const status = ['queued', 'submitting'].includes(result.status) ? 'uploading' : result.status;
        this.update(row.export_job, status, result.error || (status === 'uncertain' ? unknownSubmission : ''),
          result.progress ?? null, String(result.aid ?? ''), result.bvid ?? '', status === 'failed' && result.canRetry === true);
      } catch (error) {
        this.update(row.export_job, error.taskMissing ? 'uncertain' : 'uploading',
          error.taskMissing ? unknownSubmission : error.message, row.progress, row.aid || '', row.bvid || '');
      }
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.submissions.values(), this.active]);
  }
}
