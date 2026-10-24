#!/usr/bin/env node
// Run with Node 24+. This creates isolated databases; it never opens app data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(self), '../..');
const runTool = async (tool, args, options = {}) => (await exec(tool, args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, windowsHide: true, ...options,
})).stdout;
const round = value => Math.round(value * 100) / 100;
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const parse = argv => {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    assert.ok(argv[i].startsWith('--'), `Expected --option, got ${argv[i]}`);
    const key = argv[i].slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return result;
};
const integer = (value, fallback, min, max) => {
  const number = value === undefined ? fallback : Number(value);
  assert.ok(Number.isInteger(number) && number >= min && number <= max, `Expected integer ${min}..${max}, got ${value}`);
  return number;
};
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const metadata = async (file, ffprobe, countFrames = false) => JSON.parse(await runTool(ffprobe, [
  '-v', 'error', ...(countFrames ? ['-count_frames'] : []), '-show_entries',
  'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,nb_read_frames,start_time,duration', '-of', 'json', file,
]));

async function environment(ffmpeg) {
  let machine = {};
  if (process.platform === 'darwin') {
    try {
      const [chip, memory, pressure] = await Promise.all([
        runTool('sysctl', ['-n', 'machdep.cpu.brand_string']), runTool('sysctl', ['-n', 'hw.memsize']), runTool('memory_pressure', ['-Q']),
      ]);
      machine = { chip: chip.trim(), physicalMemoryBytes: Number(memory.trim()), memoryPressure: pressure.trim() };
    } catch { /* Optional host diagnostics. */ }
  }
  return { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
    logicalCpus: os.availableParallelism(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg(), ...machine, ffmpeg: (await runTool(ffmpeg, ['-version'])).split('\n')[0] };
}

async function makeFixture(config, implementation, directory) {
  const [{ Store }, { Ingestor }, { Media }] = await Promise.all(['store', 'ingest', 'media'].map(name =>
    import(pathToFileURL(path.join(implementation, 'server', `${name}.js`)).href)));
  const store = new Store(path.join(directory, 'data'));
  store.projectRoot = directory;
  const session = store.createSession({ status: 'finished', title: '隔离处理性能测试', created: '2026-10-23T00:00:00+08:00' });
  // addSource places the XML sidecar beside the FLV. Clone/copy first so a
  // supplied --source and any existing neighbouring XML remain read-only.
  const localSource = path.join(directory, 'source.flv');
  await fs.copyFile(config.source, localSource, fsConstants.COPYFILE_FICLONE);
  const source = store.addSource(session.id, localSource, 0, session.created, true);
  const messages = ['欢迎来到直播间，今天一起测试', '清晰度和弹幕数量保持不变', '这是一条稍长的中文弹幕，检查跨块连续显示', '菜包录包机性能验证'];
  const comments = Array.from({ length: Math.floor(config.duration * config.commentsPerSecond) }, (_, i) =>
    `<d p="${(i / config.commentsPerSecond + .1).toFixed(3)},1,25,16777215,0,0,0,0">${messages[i % messages.length]} ${i}</d>`);
  await fs.writeFile(source.xml, `<i>${comments.join('')}</i>`);
  const ingest = new Ingestor(store);
  const maxTicks = Math.ceil((await fs.stat(localSource)).size / (16 * 1024 ** 2)) + 4;
  let previousPosition = -1;
  for (let i = 0; i < maxTicks; i++) {
    await ingest.tick();
    const current = store.sources(session.id)[0];
    assert.equal(current.error, '', current.error);
    if (current.closed === 2) break;
    const position = ingest.states.get(source.id)?.pos ?? current.pos;
    assert.ok(position > previousPosition, 'Fixture ingest stopped making progress');
    previousPosition = position;
  }
  const persisted = store.sources(session.id)[0];
  assert.equal(persisted.error, '', persisted.error);
  assert.ok(persisted.closed === 2, 'Fixture ingest must be complete before timing');
  const media = new Media(store, {
    ffmpeg: config.ffmpeg, ffprobe: config.ffprobe, exportAcceleration: config.acceleration,
    renderBlockSeconds: config.blockSeconds,
    idleRenderOptions: { mode: config.idleMode },
    renderCacheOptions: { minFreeBytes: 0, maxBytes: 12 * 1024 ** 3 },
  });
  media.work = async () => {}; // Export manually so timing includes exactly the requested job.
  const font = await media.fonts.import(await fs.readFile(config.font));
  return { store, session, media, font, duration: store.session(session.id).duration,
    async close() { media.close(); await media.waitForSaves(); store.close(); } };
}

// RSS is sampled, not an OS-enforced maximum. It includes this worker plus its
// active FFmpeg/FFprobe children; the parent and source generation are excluded.
function monitor(media) {
  let sampling = false, maxRssKiB = null, maxChildren = 0, samples = 0;
  const sample = async () => {
    maxChildren = Math.max(maxChildren, media.children.size);
    if (sampling || process.platform === 'win32') return;
    sampling = true;
    try {
      const pids = [process.pid, ...[...media.children].map(child => child.pid).filter(Boolean)];
      const output = await runTool('ps', ['-o', 'rss=', '-p', pids.join(',')]);
      const sum = output.trim().split(/\s+/).filter(Boolean).reduce((total, value) => total + Number(value), 0);
      if (Number.isFinite(sum)) { maxRssKiB = Math.max(maxRssKiB || 0, sum); samples++; }
    } catch { /* A child can exit between collecting its PID and ps. */ }
    finally { sampling = false; }
  };
  const timer = setInterval(sample, 250);
  const originalSpawn = media.spawnTracked;
  media.spawnTracked = function (...args) {
    const child = originalSpawn.apply(this, args);
    queueMicrotask(() => { maxChildren = Math.max(maxChildren, media.children.size); });
    return child;
  };
  void sample();
  return async () => {
    clearInterval(timer);
    while (sampling) await new Promise(resolve => setTimeout(resolve, 5));
    await sample();
    media.spawnTracked = originalSpawn;
    return { maxMediaChildren: maxChildren, sampledPeakRssKiB: maxRssKiB, rssSamples: samples, sampleIntervalMs: 250 };
  };
}

async function measured(fixture, action) {
  const stop = monitor(fixture.media), started = performance.now(), loadAverage = os.loadavg();
  let result, elapsedMs, resources;
  try { result = await action(); }
  finally { elapsedMs = performance.now() - started; resources = await stop(); }
  return { ...result, elapsedMs: round(elapsedMs), loadAverage, resources };
}

async function validate(config, file, expectedDuration, name, frameTolerance = 0) {
  const started = performance.now(), info = await metadata(file, config.ffprobe, config.fullValidate);
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const audio = info.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video && audio, 'Export must contain both video and audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.r_frame_rate, '60/1');
  assert.equal(video.width, config.width); assert.equal(video.height, config.height);
  const frames = Number(video.nb_read_frames || video.nb_frames);
  const expectedFrames = Math.round(expectedDuration * 60), frameDelta = frames - expectedFrames;
  assert.equal(frames, Math.round(Number(video.duration) * 60), `${name}: sample table and video duration disagree`);
  assert.ok(Math.abs(frameDelta) <= frameTolerance, `${name}: output frame count ${frames}, expected ${expectedFrames} ± ${frameTolerance}`);
  assert.ok(Math.abs(Number(info.format.duration) - expectedDuration) < .15, `${name}: container duration`);
  assert.ok(Math.abs(Number(video.duration) - expectedDuration) < (frameTolerance ? .08 : .05), `${name}: video duration`);
  assert.ok(Math.abs(Number(audio.duration) - expectedDuration) < .15, `${name}: audio duration`);
  const times = [...new Set([.1, Math.max(.1, expectedDuration - 1), ...Array.from(
    { length: Math.min(4, Math.floor((expectedDuration - .25) / config.blockSeconds)) }, (_, i) => (i + 1) * config.blockSeconds - .1,
  )])];
  const boundaries = [];
  for (const time of times) {
    await runTool(config.ffmpeg, ['-v', 'error', '-xerror', '-ss', String(time), '-i', file, '-t', '0.2', '-f', 'null', '-']);
    const image = await runTool(config.ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1',
      '-vf', 'scale=160:90', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(image.length, 160 * 90);
    const sampleFile = path.join(config.output, `${name}-frame-${time.toFixed(3)}.gray`);
    await fs.writeFile(sampleFile, image);
    boundaries.push({ time, sha256: createHash('sha256').update(image).digest('hex'), file: sampleFile });
  }
  return { elapsedMs: round(performance.now() - started), frames, expectedFrames, frameDelta, frameTolerance, expectedDuration, metadata: info, boundaries,
    frameCounting: config.fullValidate ? 'decoded every frame' : 'MP4 sample-table frame count plus boundary decode' };
}

async function exportOne(config, fixture, options, name, frameTolerance = 0) {
  const measuredResult = await measured(fixture, async () => {
    const job = await fixture.media.enqueue(fixture.session.id, {
      mode: 'danmaku', scope: 'full', exportDirectory: path.join(config.work, 'exports'), ...options,
    });
    const file = await fixture.media.exportJob(job);
    return { job: { performance: job.performance, encoder: job.encoder, encoderFallback: job.encoderFallback,
      preparedBlocks: job.preparedBlocks, renderedBlocks: job.renderedBlocks, audioStreamCopy: job.audioStreamCopy,
      audioStreamCopyFallback: job.audioStreamCopyFallback, preparationFallback: job.preparationFallback }, file };
  });
  const expectedDuration = options.ranges ? options.ranges.reduce((sum, range) => sum + range.end - range.start, 0) : fixture.duration;
  const validation = await validate(config, measuredResult.file, expectedDuration, name, frameTolerance);
  const { file, ...timing } = measuredResult;
  return { ...timing, inputSeconds: expectedDuration, validation, ...(config.keepMedia ? { file } : {}) };
}

async function worker(config) {
  const result = { variant: config.variant, repetition: config.repetition, implementation: config.implementation,
    idleMode: config.idleMode, started: new Date().toISOString(), environment: await environment(config.ffmpeg), stages: {} };
  let fixture;
  try {
    const setupStarted = performance.now();
    fixture = await makeFixture(config, config.implementation, path.join(config.work, 'warm'));
    result.setupMs = round(performance.now() - setupStarted);
    result.duration = fixture.duration; result.font = fixture.font;
    if (config.scenarios.includes('warm') || config.scenarios.includes('clip')) {
      result.stages.preparation = await measured(fixture, async () => {
        const rounds = [];
        for (let i = 0; i < Math.ceil(config.duration / config.blockSeconds) + 5; i++) {
          const t = performance.now(), status = await fixture.media.prepareNext(fixture.session.id, {});
          rounds.push({ elapsedMs: round(performance.now() - t), performance: status.performance, done: status.done });
          log(`${config.variant} #${config.repetition}: preparation round ${i + 1}, ${round((performance.now() - t) / 1000)}s`);
          if (status.done) return { rounds };
        }
        throw new Error('Preparation did not finish in the bounded number of rounds');
      });
      result.encoder = await fixture.media.renderer.encoder();
      if (config.scenarios.includes('warm')) result.stages.warmExport = await exportOne(config, fixture, {}, `${config.runName}-warm`);
      if (config.scenarios.includes('clip')) {
        const start = Math.min(3.25, fixture.duration / 4), end = Math.min(fixture.duration - .25, start + config.clipSeconds);
        result.stages.clipExport = await exportOne(config, fixture, { scope: 'clips', ranges: [{ start, end }] }, `${config.runName}-clip`);
      }
    }
    await fixture.close(); fixture = null;
    if (config.scenarios.includes('cold')) {
      fixture = await makeFixture(config, config.implementation, path.join(config.work, 'cold'));
      // The existing non-cache path can differ by up to three frames at an
      // FLV's initial B-frame/AAC timestamp offset. Record that difference;
      // do not apply this tolerance to frame-aligned prepared exports.
      result.stages.coldExport = await exportOne(config, fixture, {}, `${config.runName}-cold`, 3);
      result.encoder = await fixture.media.renderer.encoder();
    }
    result.finished = new Date().toISOString();
    await fs.writeFile(config.resultFile, JSON.stringify(result, null, 2));
  } finally { if (fixture) await fixture.close(); }
}

function summary(reports) {
  const stages = ['preparation', 'warmExport', 'clipExport', 'coldExport'];
  const rows = [];
  for (const stage of stages) {
    const before = reports.filter(r => r.variant === 'before' && r.stages[stage]);
    const after = reports.filter(r => r.variant === 'after' && r.stages[stage]);
    if (!before.length && !after.length) continue;
    const row = { stage, beforeRuns: before.length, afterRuns: after.length };
    for (const [key, runs] of [['before', before], ['after', after]]) if (runs.length) {
      row[`${key}MedianMs`] = round(median(runs.map(r => r.stages[stage].elapsedMs)));
      if (stage !== 'clipExport') row[`${key}TwoHourEstimateMs`] = round(median(runs.map(r => r.stages[stage].elapsedMs / r.duration)) * 7200);
    }
    if (before.length && after.length) {
      row.timeReductionPercent = round((1 - row.afterMedianMs / row.beforeMedianMs) * 100);
      row.speedFactor = round(row.beforeMedianMs / row.afterMedianMs);
    }
    rows.push(row);
  }
  return rows;
}

async function compareFrames(reports) {
  const reference = reports.find(r => r.variant === 'before');
  if (!reference) return [];
  const results = [];
  for (const candidate of reports.filter(r => r.variant === 'after')) for (const [stage, value] of Object.entries(reference.stages)) {
    const corresponding = candidate.stages[stage];
    if (!value.validation || !corresponding?.validation) continue;
    for (let i = 0; i < value.validation.boundaries.length; i++) {
      const a = value.validation.boundaries[i], b = corresponding.validation.boundaries[i];
      if (!b || a.time !== b.time) continue;
      const [x, y] = await Promise.all([fs.readFile(a.file), fs.readFile(b.file)]);
      const mae = x.reduce((total, byte, index) => total + Math.abs(byte - y[index]), 0) / x.length;
      results.push({ repetition: candidate.repetition, stage, time: a.time, grayscaleMeanAbsoluteError: round(mae), exact: a.sha256 === b.sha256 });
      assert.ok(mae < 5, `Large before/after image difference at ${stage} ${a.time}s: ${mae}`);
    }
  }
  return results;
}

async function writeReport(config, reports) {
  const rows = summary(reports), frameComparisons = await compareFrames(reports);
  const data = { benchmarkVersion: 1, config, limitations: [
    'Synthetic moving test pattern and Chinese comments, not a real two-hour recording.',
    'Two-hour estimates scale median per-input-second time to 7200 seconds. Startup, thermal limits, cache capacity, and real source complexity may differ.',
    'Preparation and export are reported separately; setup, source generation and validation are excluded from media timings.',
    'ABBA order reduces but does not eliminate filesystem-cache and thermal effects. No OS cache purge is performed.',
    'Peak RSS is sampled for worker plus active media processes; memory samples are not exact OS peaks.',
    'Auto acceleration must be interpreted using the actual encoder ID; software fallback is not a GPU result.',
    'Prepared exports require exact planned frame counts. Legacy cold exports allow a recorded three-frame initial FLV timestamp tolerance; sample table and video duration must still agree.',
  ], rows, frameComparisons, reports };
  await fs.writeFile(path.join(config.output, 'report.json'), JSON.stringify(data, null, 2));
  const seconds = ms => ms === undefined ? '—' : `${round(ms / 1000)} s`;
  const lines = ['# 本地处理性能对照', '',
    `输入：${config.duration} 秒，${config.width} × ${config.height}，30 fps；输出：60 fps；弹幕 ${config.commentsPerSecond} 条/秒。`,
    `编码设置：${config.acceleration}；实际编码器：${[...new Set(reports.map(r => r.encoder?.id))].join('、')}；顺序：${reports.map(r => r.variant).join(' → ')}。`, '',
    '| 阶段 | 优化前中位数 | 优化后中位数 | 耗时减少 | 2 小时前估计 | 2 小时后估计 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(r => `| ${r.stage} | ${seconds(r.beforeMedianMs)} | ${seconds(r.afterMedianMs)} | ${r.timeReductionPercent === undefined ? '—' : `${r.timeReductionPercent}%`} | ${seconds(r.beforeTwoHourEstimateMs)} | ${seconds(r.afterTwoHourEstimateMs)} |`),
    '', '**2 小时数字为短样本线性外推，不是实际录制或处理 2 小时录像的实测。**', '',
    '源文件生成、导入和验证不计入处理耗时。短剪辑不外推为整场导出。准备完成后的导出等待，与包含准备的总耗时应分开解读。', '',
    '完整环境、阶段计时、采样内存、帧数/音画时长和分块边界图像对照见 report.json。编码器、分辨率、画质参数、字体和弹幕保持相同；真实内容复杂度、散热和磁盘可能改变结果。', '',
  ];
  await fs.writeFile(path.join(config.output, 'report.md'), lines.join('\n'));
}

async function main(args) {
  if (args.help) {
    console.log(`Usage: node scripts/benchmark-processing.mjs --base /path/to/before/live-editor [options]
  --after PATH          Current live-editor root (default: script parent)
  --output PATH         Results directory (must not contain benchmark-config.json)
  --source PATH         Reuse a source FLV instead of generating it
  --variant both|before|after|generate  Default both; generate writes source only
  --duration 300 --size 1920x1080 --repeats 2 --acceleration software|auto
  --scenarios warm,clip  Add cold for a full export without prepared video
  --idle-mode adaptive  Candidate mode; before always uses legacy
  --summarize REPORT1,REPORT2  Merge existing report.json files, without media work
  --block-seconds 60 --clip-seconds 30 --comments-per-second 3
  --ffmpeg PATH --ffprobe PATH --font PATH --keep-media --full-validate
Results include source/setup/validation time separately and a clearly labelled 7200s extrapolation.
Default order is before, after, after, before. All databases are under a new private temp directory.`);
    return;
  }
  if (args.summarize) {
    assert.equal(typeof args.summarize, 'string');
    const existing = await Promise.all(args.summarize.split(',').map(file => fs.readFile(path.resolve(file), 'utf8').then(JSON.parse)));
    const output = path.resolve(args.output || path.join(os.tmpdir(), `caibao-speed-summary-${Date.now()}`));
    await fs.mkdir(output, { recursive: true });
    const reference = existing[0].config;
    for (const report of existing) for (const key of ['duration', 'width', 'height', 'acceleration', 'commentsPerSecond', 'blockSeconds']) {
      assert.equal(report.config[key], reference[key], `Cannot combine different ${key}`);
    }
    const config = { ...reference, output, combinedReports: args.summarize.split(',') };
    await fs.writeFile(path.join(output, 'benchmark-config.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
    await writeReport(config, existing.flatMap(report => report.reports));
    log(`Combined report: ${path.join(output, 'report.md')}`); return;
  }
  const size = /^(\d+)x(\d+)$/.exec(args.size || '1920x1080'); assert.ok(size, '--size must be WIDTHxHEIGHT');
  const variant = args.variant || 'both'; assert.ok(['before', 'after', 'both', 'generate'].includes(variant));
  const after = path.resolve(args.after || path.join(project, 'live-editor'));
  const output = path.resolve(args.output || path.join(os.tmpdir(), `caibao-speed-report-${Date.now()}`));
  await fs.mkdir(output, { recursive: true });
  const config = {
    base: args.base ? path.resolve(args.base) : null, after, output,
    duration: integer(args.duration, 300, 2, 7200), width: Number(size[1]), height: Number(size[2]),
    repeats: integer(args.repeats, 2, 1, 10), acceleration: args.acceleration || 'software', idleMode: args['idle-mode'] || 'adaptive',
    blockSeconds: integer(args['block-seconds'], 60, 1, 600), clipSeconds: integer(args['clip-seconds'], 30, 1, 600),
    commentsPerSecond: integer(args['comments-per-second'], 3, 1, 50),
    scenarios: (args.scenarios || 'warm,clip').split(','), keepMedia: !!args['keep-media'], fullValidate: !!args['full-validate'],
    ffmpeg: path.resolve(args.ffmpeg || process.env.FFMPEG_PATH || path.join(project, '.tools/runtime/ffmpeg/ffmpeg')),
    ffprobe: path.resolve(args.ffprobe || process.env.FFPROBE_PATH || path.join(project, '.tools/runtime/ffmpeg/ffprobe')),
    font: path.resolve(args.font || process.env.CAIBO_TEST_FONT || path.join(project, '.tools/ci-fonts/NotoSansCJKsc-Regular.otf')),
  };
  assert.ok(['software', 'auto'].includes(config.acceleration));
  assert.ok(config.scenarios.every(s => ['warm', 'clip', 'cold'].includes(s)));
  assert.ok(config.width >= 160 && config.height >= 90 && !(config.width % 2) && !(config.height % 2));
  if (['before', 'both'].includes(variant)) assert.ok(config.base, '--base is required');
  // An exclusive marker prevents accidentally replacing a previous report.
  await fs.writeFile(path.join(output, 'benchmark-config.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
  const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'caibao-speed-isolated-'));
  const reports = [];
  try {
    config.source = args.source ? path.resolve(args.source) : path.join(scratch, 'source.flv');
    if (!args.source) {
      const started = performance.now(); log(`Generating ${config.duration}s ${config.width}x${config.height} moving source`);
      await runTool(config.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${config.width}x${config.height}:rate=30`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(config.duration),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-y', config.source]);
      config.sourceGenerationMs = round(performance.now() - started);
    }
    const sourceInfo = await metadata(config.source, config.ffprobe);
    const sourceVideo = sourceInfo.streams.find(s => s.codec_type === 'video');
    assert.equal(sourceVideo.width, config.width); assert.equal(sourceVideo.height, config.height);
    assert.ok(Math.abs(Number(sourceInfo.format.duration) - config.duration) < .2, '--duration must match reused source');
    config.sourceMetadata = sourceInfo;
    if (variant === 'generate') {
      const destination = path.join(output, 'source.flv');
      if (args.source) await fs.copyFile(config.source, destination); else await fs.rename(config.source, destination);
      config.source = destination;
      await fs.writeFile(path.join(output, 'source.json'), JSON.stringify(config, null, 2));
      log(`Source ready: ${destination}`); return;
    }
    const order = [];
    for (let i = 0; i < config.repeats; i++) {
      const variants = variant === 'both' ? (i % 2 ? ['after', 'before'] : ['before', 'after']) : [variant];
      for (const value of variants) order.push({ variant: value, repetition: i + 1 });
    }
    for (const item of order) {
      const runName = `${item.variant}-${item.repetition}`, work = path.join(scratch, runName);
      await fs.mkdir(work);
      const resultFile = path.join(output, `${runName}.json`), workerConfig = { ...config, ...item, runName, work, resultFile,
        implementation: item.variant === 'before' ? config.base : config.after, idleMode: item.variant === 'before' ? 'legacy' : config.idleMode };
      const configFile = path.join(work, 'worker.json'); await fs.writeFile(configFile, JSON.stringify(workerConfig));
      log(`Starting ${runName}`);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [self, '--worker', configFile], { stdio: 'inherit', env: process.env });
        child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${runName} exited: ${code ?? signal}`)));
      });
      reports.push(JSON.parse(await fs.readFile(resultFile, 'utf8')));
      await writeReport(config, reports);
      if (!config.keepMedia) await fs.rm(work, { recursive: true, force: true });
      log(`Finished ${runName}; report: ${path.join(output, 'report.md')}`);
    }
    if (config.keepMedia) log(`Media retained for inspection in ${scratch}`);
  } finally {
    if (!config.keepMedia) {
      const relative = path.relative(await fs.realpath(os.tmpdir()), scratch);
      assert.ok(relative.startsWith('caibao-speed-isolated-') && !relative.includes(path.sep));
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
}

const args = parse(process.argv.slice(2));
try {
  if (args.worker) await worker(JSON.parse(await fs.readFile(args.worker, 'utf8')));
  else await main(args);
} catch (error) { console.error(error.stack || error); process.exitCode = 1; }
