import fs from 'node:fs/promises';
import path from 'node:path';
import { FLV_HEADER } from '../../server/ingest.js';
import { Media } from '../../server/media.js';
import { minimalMp4 } from './mp4-fixture.js';

export async function saveRetryFixture(store, media = new Media(store, { exportAcceleration: 'software' }), { mode = 'dual', scope = 'clips' } = {}) {
  const session = store.createSession({ title: '保存重试验证', status: 'finished', created: '2026-09-29T12:00:00+08:00' });
  const original = path.join(store.root, session.id + '.flv');
  await fs.writeFile(original, FLV_HEADER);
  const source = store.addSource(session.id, original, 0, session.created, true);
  store.run('UPDATE sessions SET duration=10 WHERE id=?', session.id);
  store.run('UPDATE sources SET closed=2,duration=10 WHERE id=?', source.id);
  store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, 0, 0, 0);
  media.exportAcceleration = 'software';
  media.work = async () => {};
  media.probeSource = async () => ({ width: 640, height: 360, fps: 30 });
  const calls = [];
  media.process = async (args, options = {}) => {
    calls.push([...args]);
    for (const argument of args) if (/^(?:part-\d+(?:-danmaku)?|final(?:-danmaku)?)\.mp4$/.test(argument)) {
      await fs.writeFile(path.join(options.cwd, argument), minimalMp4);
    }
  };
  const job = await media.enqueue(session.id, { scope, mode, ranges: [{ start: 0, end: 2 }], exportDirectory: path.join(path.dirname(store.root), 'outputs') });
  return { store, media, session, source, original, job, calls, run: () => Media.prototype.work.call(media) };
}

export async function collideSave(fixture) {
  const occupied = fixture.job.output.danmakuFile || fixture.job.output.file;
  await fs.writeFile(occupied, '用户已有的视频，不能覆盖');
  await fixture.run();
  return occupied;
}
