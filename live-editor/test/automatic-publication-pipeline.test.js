import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AutoPost } from '../server/auto-post.js';
import { BackgroundPreparation } from '../server/background-preparation.js';
import { Ingestor, sourceStream } from '../server/ingest.js';
import { Media } from '../server/media.js';
import { Store } from '../server/store.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

async function waitFor(check) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the media pipeline');
    await delay(25);
  }
}

test('three recordings hand off independently, reusing an export after recording pressure', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'caibo-post-pipeline-'));
  const store = new Store(path.join(root, 'data'));
  store.defaultExportRoot = path.join(root, 'exports');
  const ingest = new Ingestor(store);
  const media = new Media(store, { ffmpeg, ffprobe, exportAcceleration: 'software' });
  let healthy = false;
  media.isRecording = () => !!store.get("SELECT 1 FROM sessions WHERE status='recording'");
  media.automaticMediaAllowed = () => !media.isRecording() || healthy;
  const preparation = new BackgroundPreparation(store, media, {
    idleGraceMs: 0, busyReason: () => media.isRecording() ? 'recording' : '',
  });
  media.preparation = preparation;
  preparation.wake = () => {};
  preparation.start();

  const fixture = path.join(root, 'capture.flv');
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-f','lavfi','-i',
    'sine=frequency=440:sample_rate=48000','-t','6','-c:v','libx264','-preset','ultrafast','-g','15',
    '-pix_fmt','yuv420p','-c:a','aac','-f','flv','-y',fixture]);
  const bytes = await fs.readFile(fixture);
  const rooms = [123, 456, 789];
  const recorder = { anchors: rooms.map(room => ({ key: 'bilibili:' + room })), recordingForAnchor: () => null };
  const credentials = {
    get: () => 'SESSDATA=fixture; DedeUserID=123; bili_jct=fixture',
    snapshot: () => ({ platforms: { bilibili: { configured: true } } }),
  };
  const uploads = new Map();
  const publisher = {
    snapshot: () => ({ configured: true, accountUid: '123' }),
    assertCategory: async () => {},
    async submit({ owner, parts }) {
      assert.ok(!uploads.has(owner.id), 'one upload record per recording');
      assert.deepEqual(parts.map(part => part.title), ['弹幕版', '纯净版']);
      for (const { path: file } of parts) assert.ok((await fs.stat(file)).size > 0);
      uploads.set(owner.id, { status: uploads.size ? 'queued' : 'uploading' });
      return { taskId: owner.id };
    },
    async task(id) { return uploads.get(id); },
  };
  const auto = new AutoPost(store, credentials, media, recorder, () => false, publisher);
  t.after(async () => {
    await auto.close();
    await preparation.close();
    ingest.stop();
    await media.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function recording(room, openBytes) {
    const key = 'bilibili:' + room;
    await auto.settings(key, {
      enabled: true, titleTemplate: key, description: '', homepage: '', tags: ['直播回放'],
      categoryId: '171', mode: 'dual', copyright: 1, accountUid: '123',
    });
    const session = store.createSession({ room, status: 'recording', created: new Date(Date.now() + 1000).toISOString() });
    const file = path.join(root, room + '.flv');
    await fs.writeFile(file, bytes.subarray(0, openBytes));
    const source = store.addSource(session.id, file, 0, session.created, false);
    auto.capture(session, key);
    return { id: session.id, source: source.id, file };
  }

  const a = await recording(123, bytes.length);
  const b = await recording(456, bytes.length);
  const cut = Math.floor(bytes.length * .45);
  const c = await recording(789, cut);
  await ingest.tick();
  async function finish(recording) {
    store.run("UPDATE sessions SET status='finishing' WHERE id=?", recording.id);
    store.run('UPDATE sources SET closed=1 WHERE id=?', recording.source);
    await ingest.tick();
    assert.equal(store.sources(recording.id)[0].closed, 2);
    store.run("UPDATE sessions SET status='finished' WHERE id=?", recording.id);
  }
  const job = id => store.get('SELECT id,status,error FROM jobs WHERE session=?', id);
  const stage = id => auto.snapshot().jobs.find(row => row.id === id)?.stage;

  await finish(a);
  await auto.tick();
  assert.equal(stage(a.id), 'waiting-idle');
  assert.equal(job(a.id), undefined);
  healthy = true;
  await auto.tick();
  await preparation.tick();
  assert.equal(preparation.status(a.id).status, 'ready');
  await auto.tick();
  await waitFor(() => ['done', 'failed'].includes(job(a.id)?.status));
  assert.equal(job(a.id).status, 'done', job(a.id).error);
  await auto.tick();
  assert.equal(uploads.get(a.id)?.status, 'uploading',
    JSON.stringify(store.get('SELECT status,error,result FROM auto_post_jobs WHERE session=?', a.id)));
  assert.equal(store.session(b.id).status, 'recording');

  await finish(b);
  await auto.tick();
  const before = store.session(c.id).duration;
  const preparing = preparation.tick();
  await fs.appendFile(c.file, bytes.subarray(cut));
  await ingest.tick();
  await preparing;
  assert.equal(preparation.status(b.id).status, 'ready');
  assert.ok(store.session(c.id).duration > before + 1, 'C keeps indexing while A uploads and B prepares');
  assert.equal(store.sources(c.id)[0].closed, 0);

  const perform = media.performExportJob.bind(media);
  let yielded = false;
  media.performExportJob = async details => {
    if (details.session === b.id && !yielded) {
      yielded = true;
      healthy = false;
      media.maintainAutomaticExports();
      media.assertExportActive();
    }
    return perform(details);
  };
  await auto.tick();
  await waitFor(() => yielded && !media.processing);
  const originalJob = job(b.id);
  assert.equal(originalJob.status, 'queued');
  assert.equal(originalJob.error, '');
  media.maintainAutomaticExports();
  assert.equal(job(b.id).status, 'queued');
  healthy = true;
  media.maintainAutomaticExports();
  await waitFor(() => ['done', 'failed'].includes(job(b.id)?.status));
  assert.equal(job(b.id).status, 'done', job(b.id).error);
  assert.equal(job(b.id).id, originalJob.id);
  await auto.tick();
  assert.equal(uploads.get(a.id)?.status, 'uploading',
    JSON.stringify(store.get('SELECT status,error,result FROM auto_post_jobs WHERE session=?', a.id)));
  assert.equal(uploads.get(b.id).status, 'queued');
  await auto.tick();
  assert.equal(stage(b.id), 'waiting-upload');

  await finish(c);
  assert.deepEqual(await fs.readFile(c.file), bytes);
  const rebuilt = path.join(root, 'verified-c.flv'), parts = [];
  for await (const chunk of sourceStream(store, c.source, 0, store.session(c.id).duration)) parts.push(chunk);
  await fs.writeFile(rebuilt, Buffer.concat(parts));
  execFileSync(ffmpeg, ['-v','error','-xerror','-i',rebuilt,'-map','0:v:0','-map','0:a:0','-f','null','-']);
  await auto.tick();
  await preparation.tick();
  await auto.tick();
  await waitFor(() => ['done', 'failed'].includes(job(c.id)?.status));
  assert.equal(job(c.id).status, 'done', job(c.id).error);
  await auto.tick();
  assert.equal(uploads.size, 3);
  assert.equal(store.all('SELECT id FROM jobs').length, 3);
});
