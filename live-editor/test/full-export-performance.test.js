import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Ingestor, sourceStream } from '../server/ingest.js';
import { Media } from '../server/media.js';
import { clipFile } from '../server/output-names.js';
import { canCopyFullSource, videoGeometryFilter, videoMetadata } from '../server/export-encoding.js';

const runtime = path.resolve('..', '..', '程序组件', 'runtime', 'ffmpeg');
const ffmpeg = process.env.FFMPEG_PATH || path.join(runtime, 'ffmpeg.exe');
const ffprobe = process.env.FFPROBE_PATH || path.join(runtime, 'ffprobe.exe');
const execute = (tool, args, encoding) => execFileSync(tool, args, { windowsHide: true, ...(encoding ? { encoding } : {}) });
const validInfo = { metadataVersion: 2, width: 320, height: 180, fps: 30, codec: 'h264', pixelFormat: 'yuv420p', sampleAspectRatio: '1:1', videoStreams: 1, audioStreams: 1, audioCodec: 'aac' };

test('full stream copy and geometry omission require positively verified compatible metadata', () => {
  const source = { start: 0, duration: 10, closed: 2 }, job = { scope: 'full', ranges: [{ start: 0, end: 10 }] };
  assert.equal(canCopyFullSource(job, [source], validInfo, 0), true);
  assert.equal(canCopyFullSource(job, [source], { ...validInfo, audioStreams: 0, audioCodec: null }, 0), true);
  for (const patch of [{ metadataVersion: 1 }, { audioCodec: null }, { audioCodec: 'mp3' }, { audioStreams: 2 },
    { videoStreams: 2 }, { codec: 'hevc' }, { pixelFormat: 'yuv420p10le' }, { sampleAspectRatio: null },
    { sampleAspectRatio: '4:3' }, { width: 319 }]) assert.equal(canCopyFullSource(job, [source], { ...validInfo, ...patch }, 0), false, JSON.stringify(patch));
  assert.equal(canCopyFullSource(job, [source, source], validInfo, 0), false);
  assert.equal(canCopyFullSource({ ...job, scope: 'clips' }, [source], validInfo, 0), false);
  assert.equal(canCopyFullSource(job, [source], validInfo, .2), false);
  assert.equal(canCopyFullSource(job, [source], validInfo, undefined), false);
  assert.equal(canCopyFullSource({ ...job, ranges: [{ start: 1, end: 10 }] }, [source], validInfo, 1), false);
  assert.equal(videoGeometryFilter(validInfo, 320, 180), '');
  assert.match(videoGeometryFilter({ ...validInfo, sampleAspectRatio: null }, 320, 180), /scale=.*pad=.*setsar=1/);
  assert.match(videoGeometryFilter(validInfo, 640, 360), /scale=640:360/);
  const upgraded = videoMetadata([{ codec_type: 'video', codec_name: 'h264', width: 320, height: 180, r_frame_rate: '30/1', pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1' }, { codec_type: 'audio', codec_name: 'aac' }]);
  assert.deepEqual(upgraded, validInfo);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-full-perf-'));
  let store, media;
  t.after(async () => {
    media?.close(); if(media)await media.waitForSaves(); store?.close();
    const relative = path.relative(await fs.realpath(os.tmpdir()), await fs.realpath(root));
    assert.ok(relative.startsWith('bili-full-perf-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'input.flv');
  execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-itsoffset', '0.12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2.4', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '30', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file]);
  store = new Store(path.join(root, 'data')); store.projectRoot = root;
  const session = store.createSession({ status: 'finished', created: '2026-09-29T12:00:00+08:00' });
  const source = store.addSource(session.id, file, 0, session.created, true);
  await fs.writeFile(source.xml, '<i><d p="0.4,1,25,16777215,0,0,0,0">Keep rolling at sixty frames</d></i>');
  const ingest = new Ingestor(store);
  for (let i = 0; i < 3; i++) await ingest.tick();
  assert.equal(store.get('SELECT closed FROM sources WHERE id=?', source.id).closed, 2);
  media = new Media(store, { ffmpeg, ffprobe, exportAcceleration: 'software' }); media.work = async () => {};
  const calls = [], process = media.process.bind(media);
  media.process = async (args, options) => { calls.push(args); return process(args, options); };
  return { root, file, store, session, source, media, calls, process };
}

function inspect(file) {
  return JSON.parse(execute(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,r_frame_rate,nb_read_frames,start_time,duration:format=duration', '-of', 'json', file], 'utf8'));
}
function packets(file) {
  return JSON.parse(execute(ffprobe, ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,data_hash', '-of', 'json', file], 'utf8')).packets;
}
async function assertFastStart(file) {
  const bytes = await fs.readFile(file); let position = 0; const boxes = [];
  while (position < bytes.length) { const length = bytes.readUInt32BE(position); boxes.push(bytes.toString('ascii', position + 4, position + 8)); assert.ok(length >= 8); position += length; }
  assert.equal(position, bytes.length);
  assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'));
}

test('full clean remuxes trusted chunks once without opening original, preserving B-frame/AAC packet timing and payload', async t => {
  const f = await fixture(t), source = f.store.sources(f.session.id)[0], duration = f.store.session(f.session.id).duration;
  const expectedInput = path.join(f.root, 'trusted.flv'), handle = await fs.open(expectedInput, 'wx');
  try { for await (const bytes of sourceStream(f.store, source.id, 0, duration)) await handle.writeFile(bytes); } finally { await handle.close(); }
  const expected = path.join(f.root, 'expected.mp4');
  execute(ffmpeg, ['-v', 'error', '-fflags', '+genpts', '-i', expectedInput, '-t', String(duration), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-y', expected]);
  await fs.rename(f.file, f.file + '.unavailable');
  // Old cache did not contain audio/SAR: it must be probed again from chunks.
  f.store.setting('metadata:' + source.id, { width: 320, height: 180, fps: 30, codec: 'h264' });
  f.media.exportAcceleration = 'auto';
  const job = await f.media.enqueue(f.session.id, { scope: 'full', mode: 'clean', exportDirectory: path.join(f.root, 'exports') });
  const result = await f.media.exportJob(job);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].includes('copy'));
  assert.ok(!f.calls[0].includes('libx264'));
  assert.ok(!f.calls[0].includes('concat'));
  assert.ok(!f.calls[0].includes('-vf'));
  assert.equal(job.cleanStreamCopy, true);
  assert.deepEqual(packets(result), packets(expected));
  assert.deepEqual(inspect(result), inspect(expected));
  await assertFastStart(result);
  execute(ffmpeg, ['-v', 'error', '-xerror', '-i', result, '-f', 'null', '-']);
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?', job.id).status, 'done');
});

test('full dual copies the clean branch and encodes one 60 fps branch without scaling or concat passes', async t => {
  const f = await fixture(t);
  const job = await f.media.enqueue(f.session.id, { scope: 'full', mode: 'dual', exportDirectory: path.join(f.root, 'exports') });
  const file = await f.media.exportJob(job), baked = clipFile(file, 'danmaku');
  assert.equal(f.calls.length, 1);
  const args = f.calls[0];
  assert.ok(args.includes('copy'));
  assert.equal(args.filter(value => value === 'libx264').length, 1);
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /fps=60,ass=/);
  assert.doesNotMatch(filter, /scale=|pad=|split=/);
  assert.equal(job.cleanStreamCopy, true);
  assert.equal(inspect(file).streams.find(s => s.codec_type === 'video').r_frame_rate, '30/1');
  assert.equal(inspect(baked).streams.find(s => s.codec_type === 'video').r_frame_rate, '60/1');
  for (const output of [file, baked]) { await assertFastStart(output); execute(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']); }
});

test('stream-copy failure retries normal encoding and single accurate cuts still encode without concat', async t => {
  const f = await fixture(t); let failed = false;
  f.media.process = async (args, options) => {
    f.calls.push(args);
    if (!failed && args.includes('copy')) { failed = true; throw new Error('simulated incompatible mux timestamps'); }
    return f.process(args, options);
  };
  const job = await f.media.enqueue(f.session.id, { scope: 'full', mode: 'clean', exportDirectory: path.join(f.root, 'exports') });
  const file = await f.media.exportJob(job);
  assert.equal(f.calls.length, 2);
  assert.equal(job.streamCopyFallback, true);
  assert.ok(f.calls[1].includes('libx264'));
  assert.ok(!f.calls[1].includes('concat'));
  assert.equal(job.cleanStreamCopy, false);
  await assertFastStart(file);
  f.calls.length = 0;
  const clip = await f.media.enqueue(f.session.id, { mode: 'clean', ranges: [{ start: .2, end: 1.2 }], exportDirectory: path.join(f.root, 'exports') });
  const clipped = await f.media.exportJob(clip);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].includes('libx264'));
  assert.ok(!f.calls[0].includes('copy'));
  assert.ok(Math.abs(Number(inspect(clipped).format.duration) - 1) < .1);
});

test('aborting an active byte-stream pipeline closes its producer and leaves no child process', async t => {
  const f = await fixture(t), controller = new AbortController(); let released = false;
  async function* input() {
    try {
      while (!controller.signal.aborted) { yield Buffer.alloc(256 * 1024); await new Promise(resolve => setTimeout(resolve, 2)); }
    } finally { released = true; }
  }
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await f.media.process(['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '320x180', '-framerate', '30', '-i', 'pipe:0', '-f', 'null', '-'], { input: input(), signal: controller.signal });
  } finally { clearTimeout(timer); }
  assert.equal(released, true);
  assert.equal(f.media.children.size, 0);
});
