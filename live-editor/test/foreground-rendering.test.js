import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { RenderPipeline, renderBlocks, frameSpan } from '../server/render-plan.js';
import { Media } from '../server/media.js';

const workDir = path.resolve('synthetic-render-workspace');
const hardware = { id: 'h264_amf', label: 'test GPU', hardware: true };
const software = { id: 'libx264', label: 'test CPU', hardware: false, threads: 2 };
const source = { id: 'source', session: 'session', start: 0, duration: 180, closed: 2 };
const spans = count => Array.from({ length: count }, (_, index) => ({ source, from: index * 10, to: (index + 1) * 10 }));
function fixture(encoder = hardware, duration = 180) {
  const item = { ...source, duration };
  const media = { store: {}, closed: false, renderCache: {
    acquire: async () => null,
    build: () => assert.fail('foreground exports must never build quota-limited cache'),
  } };
  const pipeline = new RenderPipeline(media, () => '');
  pipeline.spec = async (_plan, block) => ({ startMs: block.startMs, endMs: block.endMs });
  pipeline.inspect = async () => ({ encodingSignature: 'compatible-video' });
  const plan = { profile: { encoder }, blocks: renderBlocks([item]), sources: [item] };
  return { pipeline, media, plan, source: item };
}
function abortableWait(signal) {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', resolve, { once: true });
  });
}

for (const encoder of [hardware, software]) {
  test(`${encoder.hardware ? '硬件最多两路' : '软件串行'}：完成乱序也按时间顺序返回成片`, { timeout: 3000 }, async () => {
    const { pipeline, plan } = fixture(encoder);
    let active = 0, peak = 0;
    const completed = [];
    pipeline.renderVideo = async (_plan, _source, from) => {
      active++; peak = Math.max(peak, active);
      try { await delay(from === 0 ? 30 : 2); completed.push(from); }
      finally { active--; }
    };
    const result = await pipeline.renderForegroundParts(plan, spans(4), workDir);
    assert.equal(peak, encoder.hardware ? 2 : 1);
    assert.equal(active, 0);
    assert.deepEqual(result.files, spans(4).map((_, index) => ({ file: path.join(workDir, `part-${index}.mp4`), duration: 10 })));
    assert.equal(result.reused, 0);
    if (encoder.hardware) assert.notEqual(completed[0], 0);
    else assert.deepEqual(completed, [0, 10, 20, 30]);
  });
}

test('并行首次失败会 abort 兄弟并等待其 settle，再使用同一 GPU 串行重试', { timeout: 3000 }, async () => {
  const { pipeline, plan } = fixture();
  let calls = 0, active = 0, siblingSettled = false, serialPeak = 0, startSibling;
  const siblingStarted = new Promise(resolve => { startSibling = resolve; });
  const serialStarts = [];
  pipeline.renderVideo = async (seenPlan, _source, from, _to, _file, { signal }) => {
    const attempt = ++calls; active++;
    assert.equal(seenPlan.profile.encoder, hardware);
    try {
      if (attempt === 1) { await siblingStarted; throw new Error('GPU session busy'); }
      if (attempt === 2) {
        startSibling(); await abortableWait(signal); assert.equal(signal.aborted, true);
        await delay(20); siblingSettled = true;
        throw Object.assign(new Error('sibling canceled'), { name: 'AbortError' });
      }
      assert.equal(siblingSettled, true, 'retry must wait for the canceled sibling');
      serialPeak = Math.max(serialPeak, active); serialStarts.push(from); await delay(1);
    } finally { active--; }
  };
  const result = await pipeline.renderForegroundParts(plan, spans(3), workDir);
  assert.equal(result.serialRetry, true);
  assert.equal(calls, 5); assert.equal(active, 0); assert.equal(serialPeak, 1);
  assert.deepEqual(serialStarts, [0, 10, 20]);
  assert.deepEqual(result.files.map(item => path.basename(item.file)), ['part-0.mp4', 'part-1.mp4', 'part-2.mp4']);
});

test('同 GPU 串行重试仍失败时标记 hardwareEncoderFailure', { timeout: 3000 }, async () => {
  const { pipeline, plan } = fixture();
  let calls = 0, startSibling, settled = false;
  const siblingStarted = new Promise(resolve => { startSibling = resolve; });
  const serialError = new Error('serial GPU failure');
  pipeline.renderVideo = async (_plan, _source, _from, _to, _file, { signal }) => {
    const attempt = ++calls;
    if (attempt === 1) { await siblingStarted; throw new Error('parallel GPU failure'); }
    if (attempt === 2) { startSibling(); await abortableWait(signal); await delay(10); settled = true; throw new Error('aborted sibling'); }
    assert.equal(settled, true); throw serialError;
  };
  await assert.rejects(pipeline.renderForegroundParts(plan, spans(2), workDir), error => error === serialError && error.hardwareEncoderFailure === true);
  assert.equal(calls, 3);
});

test('服务关闭导致 worker 失败后不再启动串行重试', { timeout: 3000 }, async () => {
  const { pipeline, plan, media } = fixture();
  let calls = 0, siblingSettled = false;
  pipeline.renderVideo = async (_plan, _source, _from, _to, _file, { signal }) => {
    if (++calls === 1) { await delay(5); media.closed = true; throw new Error('service closed'); }
    await abortableWait(signal); await delay(10); siblingSettled = true; throw new Error('sibling stopped');
  };
  await assert.rejects(pipeline.renderForegroundParts(plan, spans(3), workDir), /closed/);
  assert.equal(calls, 2); assert.equal(siblingSettled, true);
});

test('前台只 acquire 已有缓存，不调用 build 或申请额度，并保留命中块的 60 秒边界', async () => {
  const { pipeline, media, plan, source } = fixture(hardware, 125);
  const acquired = [], leases = [];
  const cached = { file: 'cached-first-minute.mp4', release: async () => {} };
  media.renderCache.quotaBytes = 0;
  media.renderCache.acquire = async spec => { acquired.push(spec.startMs); return spec.startMs === 0 ? cached : null; };
  const parts = await pipeline.foregroundParts(plan, [{ source, from: 0, to: 125 }], leases);
  assert.deepEqual(acquired, [0, 60000, 120000]);
  assert.deepEqual(parts.map(part => [part.from, part.to]), [[0, 60], [60, 120], [120, 125]]);
  assert.equal(parts[0].cached, true); assert.equal(parts[0].file, cached.file);
  assert.deepEqual(leases, [cached]);
  const rendered = [];
  pipeline.renderVideo = async (_plan, _source, from, to) => { rendered.push([from, to]); };
  const result = await pipeline.renderForegroundParts(plan, parts, workDir);
  assert.deepEqual(rendered, [[60, 120], [120, 125]]);
  assert.equal(result.files[0].file, cached.file); assert.equal(result.reused, 1);
});

test('冷缓存 65 秒均分为两段 32.5 秒，非整秒边界仍严格按 60 帧对齐', async () => {
  const { pipeline, plan, source } = fixture(hardware, 100), leases = [];
  const parts = await pipeline.foregroundParts(plan, [{ source, from: 0, to: 65 }], leases);
  assert.deepEqual(parts.map(part => [part.from, part.to]), [[0, 32.5], [32.5, 65]]);
  assert.deepEqual(parts.map(part => frameSpan(part.from, part.to).frames), [1950, 1950]);
  assert.equal(leases.length, 0);
  const fractional = await pipeline.foregroundParts(plan, [{ source, from: 10.007, to: 75.019 }], []);
  const expected = frameSpan(10.007, 75.019);
  assert.equal(fractional[0].from, expected.from);
  assert.equal(fractional.at(-1).to, expected.to);
  assert.equal(fractional[0].to, fractional[1].from);
  assert.equal(fractional.reduce((sum, part) => sum + frameSpan(part.from, part.to).frames, 0), expected.frames);
  for (const part of fractional) for (const edge of [part.from, part.to]) assert.ok(Math.abs(edge * 60 - Math.round(edge * 60)) < 1e-8);
});

function exportFixture({ encoder = hardware, duration = 65, mode = 'danmaku', ready = false, renderError } = {}) {
  const calls = { renderer: 0, legacy: [], ready: 0, releases: 0 };
  const job = { id: 'job', session: 'session', scope: 'clips', mode,
    ranges: [{ start: 0, end: duration }], outputRoot: workDir, output: { file: path.join(workDir, 'final.mp4') } };
  const media = {
    closed: false, exportEncoder: Promise.resolve(encoder),
    exportContext: new AsyncLocalStorage(), exportOperations: new Map(),
    assertSessionAvailable() {},
    store: { sources: () => [source], session: () => ({ status: 'finished' }), get: () => ({ time: 0 }), run() {} },
    probeSource: async () => ({}),
    renderCache: { hasReady: async () => { calls.ready++; return ready; } },
    renderer: { exportJob: async (_job, selected) => { calls.renderer++; assert.equal(selected, encoder); if (renderError) throw renderError; return 'renderer.mp4'; } },
    encodeJob: async (_job, selected) => { calls.legacy.push(selected); return 'legacy.mp4'; },
    releaseReservation: async () => { calls.releases++; },
  };
  Object.setPrototypeOf(media, Media.prototype);
  return { media, job, calls, run: () => Media.prototype.exportJob.call(media, job) };
}

for (const mode of ['danmaku', 'dual']) {
  test(`冷缓存且硬件 ${mode} 导出达到 60 秒时进入前台 renderer`, async () => {
    const f = exportFixture({ mode, duration: 60 });
    assert.equal(await f.run(), 'renderer.mp4');
    assert.equal(f.calls.renderer, 1); assert.equal(f.calls.legacy.length, 0);
    assert.equal(f.calls.ready, 0); assert.equal(f.calls.releases, 1);
  });
}
for (const variant of [{ name: '短片', duration: 59.99 }, { name: '纯净版', mode: 'clean' }, { name: '软件编码', encoder: software }]) {
  test(`冷缓存${variant.name}保持常规导出`, async () => {
    const f = exportFixture(variant);
    assert.equal(await f.run(), 'legacy.mp4'); assert.equal(f.calls.renderer, 0);
    assert.equal(f.calls.legacy.length, 1); assert.equal(f.calls.releases, 1);
  });
}

test('已经完成编码的 savePending 错误不会回退重编码', async () => {
  const error = Object.assign(new Error('destination unavailable'), { savePending: true, hardwareEncoderFailure: true });
  const f = exportFixture({ renderError: error });
  await assert.rejects(f.run(), seen => seen === error);
  assert.equal(f.calls.renderer, 1); assert.equal(f.calls.legacy.length, 0);
  assert.equal(f.job.encoderFallback, undefined); assert.equal(f.calls.releases, 1);
});

test('renderer 的 hardwareEncoderFailure 触发 CPU 常规导出', async () => {
  const f = exportFixture({ renderError: Object.assign(new Error('GPU unavailable'), { hardwareEncoderFailure: true }) });
  assert.equal(await f.run(), 'legacy.mp4'); assert.equal(f.calls.renderer, 1);
  assert.equal(f.calls.legacy.length, 1); assert.equal(f.calls.legacy[0].hardware, false);
  assert.equal(f.calls.legacy[0].id, 'libx264'); assert.equal(f.job.encoderFallback, true);
  assert.equal((await f.media.exportEncoder).id, 'libx264');
});
