import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CompactStorage } from '../server/compact-storage.js';
import { chunkReaderCount, sourceReaderCount } from '../server/storage-files.js';
import { tags, timestamp } from '../server/ingest.js';
import { transportFixture, baselineSourceStream, sourceStream, collect } from './helpers/source-stream-fixture.js';

async function setup(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-stream-batching-'));
  const fixture = await transportFixture(root, options);
  t.after(async () => {
    fixture.ingest.stop(); fixture.store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('bili-stream-batching-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return fixture;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('批量 chunks 输送与原逐包输出逐字节相同，seek、非整秒终点和原分片均不改变', async t => {
  const { store, source } = await setup(t);
  const chunks = store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq', source.id);
  const before = await Promise.all(chunks.map(async chunk => hash(await fs.readFile(chunk.path))));
  for (const [from, to] of [[17.25, 30], [18.81, 20.03], [21.25, 21.251], [24.98, 30]]) {
    const baseline = await collect(baselineSourceStream(store, source.id, from, to));
    const batched = await collect(sourceStream(store, source.id, from, to));
    assert.deepEqual(batched.bytes, baseline.bytes);
    assert.ok(batched.blocks.length - 3 < (baseline.blocks.length - 3) / 4);
    for (const block of batched.blocks.slice(3)) {
      assert.equal(tags(block).consumed, block.length, 'batch must end on a complete tag');
      assert.ok(block.length < 256 * 1024 + 16400);
    }
  }
  assert.deepEqual(await Promise.all(chunks.map(async chunk => hash(await fs.readFile(chunk.path)))), before);
});

test('blocked 原片仍只读取 chunks，原片被改写或移走不影响批量重建', async t => {
  const { store, source, file } = await setup(t);
  const before = (await collect(baselineSourceStream(store, source.id, 17.25, 30))).bytes;
  store.run("INSERT INTO source_storage(source,mode,status,reason) VALUES(?,'chunks','blocked','原片内容不一致')", source.id);
  await fs.rename(file, file + '.untrusted');
  assert.deepEqual((await collect(sourceStream(store, source.id, 17.25, 30))).bytes, before);
  assert.equal(store.get('SELECT mode FROM source_storage WHERE source=?', source.id).mode, 'chunks');
});

test('单个视频包超过批量阈值时仍保持完整包和精确终点', async t => {
  const { store, source } = await setup(t, { seconds: 2, videoBytes: 300 * 1024 });
  const expected = (await collect(baselineSourceStream(store, source.id, 17.25, 17.31))).bytes;
  const actual = await collect(sourceStream(store, source.id, 17.25, 17.31));
  assert.deepEqual(actual.bytes, expected);
  assert.ok(actual.blocks.some(block => block.length > 256 * 1024));
  for (const block of actual.blocks.slice(3)) assert.equal(tags(block).consumed, block.length);
});

test('完整原片 direct 模式与批量 chunks 保持等价，原片指纹保护仍有效', async t => {
  const { store, source, file } = await setup(t);
  const baseline = (await collect(sourceStream(store, source.id, 19.91, 23.8))).bytes;
  store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)', source.id);
  const storage = new CompactStorage(store, { isBusy: () => false });
  try { await storage.tick(); } finally { await storage.close(); }
  assert.equal(store.get('SELECT mode FROM source_storage WHERE source=?', source.id).mode, 'direct');
  assert.deepEqual((await collect(sourceStream(store, source.id, 19.91, 23.8))).bytes, baseline);
  const stat = await fs.stat(file); await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000));
  await assert.rejects(collect(sourceStream(store, source.id, 19.91, 23.8)), /发生变化/);
  assert.equal(sourceReaderCount(store, source.id), 0);
});

test('批量输出提前 return 与 abort 都释放 chunk reader 租约', async t => {
  const { store, source } = await setup(t);
  const controller = new AbortController(), reader = sourceStream(store, source.id, 17.25, 30, { signal: controller.signal });
  for (let n = 0; n < 4; n++) await reader.next();
  assert.equal(chunkReaderCount(store, source.id), 1);
  controller.abort(); assert.equal((await reader.next()).done, true);
  assert.equal(chunkReaderCount(store, source.id), 0);
  const second = sourceStream(store, source.id, 17.25, 30);
  for (let n = 0; n < 4; n++) await second.next();
  await second.return(); assert.equal(chunkReaderCount(store, source.id), 0);
});

test('follow 每个已发布 chunk 的不足一批尾部立即输出，不等待未来片段', async t => {
  const { store, source } = await setup(t, { seconds: 2, videoBytes: 100, live: true });
  const controller = new AbortController(), reader = sourceStream(store, source.id, 17.25, 30, { follow: true, signal: controller.signal });
  for (let n = 0; n < 3; n++) await reader.next();
  let timer;
  try {
    const next = await Promise.race([reader.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('live chunk tail stalled')), 500); })]);
    assert.equal(next.done, false); assert.ok(next.value.length < 256 * 1024);
    const packetTimes = tags(next.value).items.map(({ tag }) => timestamp(tag) / 1000);
    assert.ok(packetTimes.length > 100); assert.ok(packetTimes.at(-1) < 1);
  } finally { clearTimeout(timer); controller.abort(); await reader.return(); }
  assert.equal(chunkReaderCount(store, source.id), 0);
});
