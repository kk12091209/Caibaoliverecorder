import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Ingestor, sourceStream } from '../server/ingest.js';
import { Media } from '../server/media.js';
import { CompactStorage } from '../server/compact-storage.js';
import { sourceReaderCount } from '../server/storage-files.js';
import { WaveformService, WaveformMetadata } from '../server/waveform.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const temporaryRoot = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(temporaryRoot, 'waveform-test-'));
const fixture = path.join(root, 'audio.flv'), noAudio = path.join(root, 'no-audio.flv'), delayed = path.join(root, 'delayed.flv');
const picture = ['-f', 'lavfi', '-i', 'color=c=black:size=160x90:rate=5:duration=5'];
const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p'];
const tone = "aevalsrc='if(between(t,1,2)+between(t,3,4),0.3*sin(2*PI*440*t),0)':s=48000:d=5";
execFileSync(ffmpeg, ['-v', 'error', ...picture, '-f', 'lavfi', '-i', tone, ...encode, '-c:a', 'aac', '-t', '5', '-y', fixture]);
execFileSync(ffmpeg, ['-v', 'error', ...picture, ...encode, '-an', '-y', noAudio]);
execFileSync(ffmpeg, ['-v', 'error', ...picture, '-itsoffset', '2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', ...encode, '-c:a', 'aac', '-t', '5', '-y', delayed]);
const open = [];
async function setup(name, input = fixture, start = 0) {
  const store = new Store(path.join(root, name)), session = store.createSession({ status: 'finished', room: 1 });
  const folder = path.join(store.root, 'originals'); await fs.mkdir(folder);
  const file = path.join(folder, 'original.flv'); await fs.copyFile(input, file);
  const source = store.addSource(session.id, file, start, '2026-09-28T13:30:00Z', true);
  const ingest = new Ingestor(store); for (let i = 0; i < 4; i++) await ingest.tick();
  assert.equal(store.get('SELECT closed FROM sources WHERE id=?', source.id).closed, 2);
  const media = new Media(store, { ffmpeg });
  const t = { store, session, source, media, services: [], storage: null };
  t.service = options => { const service = new WaveformService(store, media, options); t.services.push(service); return service; };
  open.push(t); return t;
}
async function calculate(service, id, options) { service.request(id, options); await service.task; return service.request(id, options); }
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('metadata parser preserves PTS across stdout chunks, silence, and last partial frame', async () => {
  const frames = [], parser = new WaveformMetadata(frame => frames.push(frame));
  parser.write('frame:0 pts:800 pts_time:1.25\nlavfi.astats.Overall.Peak_le');
  parser.write('vel=-6.020599913\nlavfi.astats.Overall.RMS_level=-inf\nframe:1 pts:1600 pts_time:2e0\n');
  parser.end('lavfi.astats.Overall.Peak_level=-inf\nlavfi.astats.Overall.RMS_level=-inf\nlavfi.astats.Overall.Number_of_samples=400');
  await new Promise((resolve, reject) => { parser.once('finish', resolve); parser.once('error', reject); });
  assert.equal(frames.length, 2); assert.equal(frames[0].time, 1.25); assert.ok(Math.abs(frames[0].peak - .5) < .00001);
  assert.equal(frames[0].rms, 0); assert.deepEqual(frames[1], { time: 2, duration: .05, peak: 0, rms: 0 });
});

test('real audio waveform identifies tones and silence on absolute source timeline, without video decode', async () => {
  const t = await setup('offset', fixture, 120), service = t.service(), commands = [];
  const spawn = t.media.spawnTracked.bind(t.media); t.media.spawnTracked = (...args) => { commands.push(args[1]); return spawn(...args); };
  const first = service.request(t.session.id, { from: 120, to: 125, bins: 50 });
  assert.equal(first.status, 'pending'); assert.ok(first.bins.every(b => b.state === 'pending'));
  await service.task; const result = service.request(t.session.id, { from: 120, to: 125, bins: 50 });
  assert.equal(result.status, 'ready'); assert.equal(result.hasAudio, true);
  assert.ok(result.bins[14].peak > .15); assert.ok(result.bins[34].rms > .1);
  assert.ok(result.bins[5].peak < .001); assert.ok(result.bins[25].peak < .001);
  assert.ok(result.bins.some(b => b.state === 'silent'));
  assert.ok(commands[0].includes('-vn')); assert.ok(commands[0].includes('0:a:0')); assert.ok(!commands[0].includes('libx264'));
  await service.task; assert.equal(commands.length, 1); assert.equal(sourceReaderCount(t.store, t.source.id), 0);
  const gap = service.request(t.session.id, { from: 118, to: 122, bins: 40 });
  assert.ok(gap.bins.slice(0, 20).every(b => b.state === 'unavailable'));
  assert.ok(gap.bins.slice(30).some(b => b.peak > .15));
});

test('audio that starts late stays late rather than shifting to the first decoded PCM sample', async () => {
  const t = await setup('delayed', delayed, 10), service = t.service();
  const result = await calculate(service, t.session.id, { from: 10, to: 15, bins: 50 });
  assert.ok(result.bins.slice(0, 18).every(b => b.peak === 0 && b.state === 'unavailable'));
  const first = result.bins.findIndex(b => b.peak > .05);
  assert.ok(first >= 18 && first <= 21, 'first audio must remain near source.start + 2 seconds: ' + first);
});

test('no audio is explicit, cached, and releases sourceStream lease after FFmpeg exits early', async () => {
  const t = await setup('none', noAudio), service = t.service(); let calls = 0;
  const decode = service.decode.bind(service); service.decode = (...args) => { calls++; return decode(...args); };
  const result = await calculate(service, t.session.id, { from: 0, to: 4, bins: 40 });
  assert.equal(result.status, 'no_audio'); assert.equal(result.hasAudio, false);
  assert.ok(result.bins.every(b => b.state === 'unavailable')); await service.task; assert.equal(calls, 1);
  assert.equal(sourceReaderCount(t.store, t.source.id), 0);
});

test('incremental live cache analyses only the appended range and survives service restart', async () => {
  const t = await setup('live'), actual = t.store.get('SELECT duration FROM sources WHERE id=?', t.source.id).duration;
  t.store.run('UPDATE sources SET closed=0,duration=1.5 WHERE id=?', t.source.id); t.store.run("UPDATE sessions SET status='recording',duration=1.5 WHERE id=?", t.session.id);
  const service = t.service(), calls = [], decode = service.decode.bind(service);
  service.decode = (...args) => { calls.push([args[1], args[2]]); return decode(...args); };
  await calculate(service, t.session.id, { to: 1.5, bins: 15 }); await service.task;
  t.store.run('UPDATE sources SET closed=2,duration=? WHERE id=?', actual, t.source.id); t.store.run("UPDATE sessions SET status='finished',duration=? WHERE id=?", actual, t.session.id);
  const result = await calculate(service, t.session.id, { to: 5, bins: 50 }); await service.task;
  assert.deepEqual(calls, [[0, 1.5], [1.5, 5]]); assert.equal(result.status, 'ready');
  await service.close(); const restarted = t.service({ decode: () => { throw new Error('cached data must not decode again'); } });
  const restored = restarted.request(t.session.id, { to: 5, bins: 50 }); await restarted.task;
  assert.deepEqual(restored, result); assert.equal(t.store.get('SELECT length(data) AS size FROM waveform_blocks WHERE source=?', t.source.id).size, 1500);
});

test('small wave cache remains valid when compact storage removes chunks; new ranges use direct reader', async () => {
  const t = await setup('compact'), service = t.service();
  await calculate(service, t.session.id, { to: 2, bins: 20 }); await service.task;
  t.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)', t.source.id);
  t.storage = new CompactStorage(t.store, { isBusy: () => false }); await t.storage.tick();
  assert.equal(t.store.get('SELECT mode FROM source_storage WHERE source=?', t.source.id).mode, 'direct');
  for (const chunk of t.store.all('SELECT path FROM chunks WHERE source=?', t.source.id)) await assert.rejects(fs.access(chunk.path), /ENOENT/);
  const cached = service.request(t.session.id, { to: 2, bins: 20 }); assert.equal(cached.status, 'ready'); await service.task;
  const extended = await calculate(service, t.session.id, { from: 3, to: 5, bins: 20 });
  assert.equal(extended.status, 'ready'); assert.ok(extended.bins[4].peak > .15); assert.equal(sourceReaderCount(t.store, t.source.id), 0);
});

test('live append throttling never leaves a short historical zoom window pending forever', async () => {
  const t = await setup('short-zoom'), calls = [];
  t.store.run('UPDATE sources SET closed=0,duration=1.5 WHERE id=?', t.source.id); t.store.run('UPDATE sessions SET duration=1.5 WHERE id=?', t.session.id);
  const service = t.service({ decode: async (source, from, to, signal, frame) => {
    calls.push([from, to]); for (let time = from; time < to - .0001; time += .1) frame({ time, duration: .1, peak: .5, rms: .2 });
  } });
  await calculate(service, t.session.id, { to: 1.5 }); await service.task;
  t.store.run('UPDATE sources SET duration=10 WHERE id=?', t.source.id); t.store.run('UPDATE sessions SET duration=10 WHERE id=?', t.session.id);
  const result = await calculate(service, t.session.id, { from: 1, to: 2, bins: 10 }); await service.task;
  assert.equal(result.status, 'ready'); assert.deepEqual(calls, [[0, 1.5], [1.5, 2]]);
});

test('cancel waits for reader cleanup and prevents any deletion-time cache write; close blocks future work', async () => {
  const t = await setup('cancel'), started = gate(), release = gate(); let cancelled = false;
  const service = t.service({ decode: async (source, from, to, signal, frame) => {
    const reader = sourceStream(t.store, source.id, from, to); await reader.next(); started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); await release.promise;
    await reader.return(); frame({ time: from, duration: .1, peak: 1, rms: 1 });
  } });
  service.request(t.session.id, { to: 4 }); await started.promise; assert.equal(sourceReaderCount(t.store, t.source.id), 1);
  const wait = service.cancelSession(t.session.id).then(() => { cancelled = true; });
  await Promise.resolve(); assert.equal(cancelled, false); assert.throws(() => service.request(t.session.id, { to: 4 }), /删除/);
  release.resolve(); await wait; assert.equal(sourceReaderCount(t.store, t.source.id), 0);
  assert.equal(t.store.get('SELECT COUNT(*) AS n FROM waveform_blocks').n, 0);
  await service.close(); service.allowSession(t.session.id); assert.throws(() => service.request(t.session.id, { to: 4 }), /删除/);
});

test('single worker processes bounded blocks, prioritises newest visible window, and caps response at 1000 bars', async () => {
  const t = await setup('bounded'); t.store.run('UPDATE sources SET duration=95 WHERE id=?', t.source.id); t.store.run('UPDATE sessions SET duration=95 WHERE id=?', t.session.id);
  const started = gate(), release = gate(), calls = []; let active = 0, maximum = 0;
  const service = t.service({ decode: async (source, from, to, signal, frame) => {
    maximum = Math.max(maximum, ++active); calls.push([from, to]);
    if (calls.length === 1) { started.resolve(); await release.promise; }
    frame({ time: from, duration: .1, peak: .5, rms: .2 }); active--;
  } });
  assert.equal(service.request(t.session.id, { to: 95, bins: 100000 }).bins.length, 1000); await started.promise;
  service.request(t.session.id, { from: 60, to: 90 }); release.resolve(); await service.task;
  assert.deepEqual(calls, [[0, 30], [60, 90]]); assert.equal(maximum, 1);
  const result = service.request(t.session.id, { from: 30, to: 60 }); assert.equal(result.status, 'pending'); await service.task;
});

test('partially cached coarse bars never claim pending or failed tails are fully ready', async () => {
  const t = await setup('partial'); t.store.run('UPDATE sources SET duration=60 WHERE id=?', t.source.id); t.store.run('UPDATE sessions SET duration=60 WHERE id=?', t.session.id);
  const service = t.service({ decode: async (source, from, to, signal, frame) => {
    if (from >= 30) { frame({ time: from, duration: .1, peak: 1, rms: 1 }); throw new Error('source unavailable'); }
    for (let time = from; time < to - .0001; time += .1) frame({ time, duration: .1, peak: .5, rms: .2 });
  } });
  await calculate(service, t.session.id, { to: 30 }); await service.task;
  const pending = service.request(t.session.id, { to: 60, bins: 1 });
  assert.equal(pending.status, 'partial'); assert.equal(pending.bins[0].state, 'pending'); assert.ok(pending.bins[0].peak > .4);
  await service.task; const failed = service.request(t.session.id, { to: 60, bins: 2 });
  assert.equal(failed.status, 'partial'); assert.equal(failed.bins[0].state, 'ready'); assert.equal(failed.bins[1].state, 'unavailable');
  assert.equal(failed.bins[1].peak, 0, 'failed partial samples must not become persistent cache');
});

test('real input read failure is not misclassified as no audio when FFmpeg also reports no stream', async () => {
  const t = await setup('read-error'), service = t.service(), spawn = t.media.spawnTracked.bind(t.media);
  const chunk = t.store.get('SELECT path FROM chunks WHERE source=? ORDER BY seq LIMIT 1', t.source.id); await fs.unlink(chunk.path);
  t.media.spawnTracked = (...args) => { const child = spawn(...args); process.nextTick(() => child.stderr.emit('data', Buffer.from("Stream map '0:a:0' matches no streams.\n"))); return child; };
  const result = await calculate(service, t.session.id, { to: 4, bins: 40 });
  assert.equal(result.status, 'unavailable'); assert.notEqual(result.hasAudio, false);
  const row = t.store.get('SELECT state,error FROM waveform_blocks WHERE source=?', t.source.id);
  assert.equal(row.state, 'error'); assert.match(row.error, /ENOENT/); assert.equal(sourceReaderCount(t.store, t.source.id), 0);
});

test.after(async () => {
  for (const t of open) { for (const service of t.services) await service.close(); await t.storage?.close(); t.media.close(); t.store.close(); }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('waveform-test-')) throw new Error('Unsafe test cleanup target');
  await fs.rm(resolved, { recursive: true, force: true });
});
