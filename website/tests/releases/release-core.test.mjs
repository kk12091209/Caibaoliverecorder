import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { atomicJson, cachedAsset, compareVersions, planRelease, publishProduct, readCatalog, validateConfig, verifyStream } from '../../scripts/release-core.mjs';

const content = Buffer.from('verified installer bytes');
const hash = createHash('sha256').update(content).digest('hex');
const product = { slug: 'recorder', repository: 'owner/private', files: [
  { id: 'win', platform: 'windows', arch: 'x64', name: 'win-{version}.exe' },
  { id: 'mac', platform: 'macos', arch: 'arm64', name: 'mac-{version}.dmg' },
] };
const release = () => ({ tag_name: 'v0.2.2', draft: false, prerelease: false, published_at: '2026-10-13T08:10:06Z', body: 'INTERNAL RELEASE NOTES',
  assets: ['win-0.2.2.exe', 'mac-0.2.2.dmg'].map((name, id) => ({ id: id + 1, state: 'uploaded', name, size: content.length, digest: `sha256:${hash}` })) });
const plan = (value = release(), previous) => planRelease(product, value, 'https://download.caibao.media', previous);
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'caibao-sync-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('正式版本按数字比较，拒绝降级、草稿和预发布', () => {
  assert.equal(compareVersions('v0.2.10', '0.2.2'), 1);
  assert.throws(() => plan({ ...release(), draft: true }), /草稿/);
  assert.throws(() => plan({ ...release(), prerelease: true }), /预发布/);
  assert.throws(() => plan({ ...release(), tag_name: 'v0.2.3-rc.1' }), /正式版本/);
  assert.throws(() => plan(release(), { version: 'v0.2.3' }), /降级/);
});

test('只匹配确切文件名，两端缺包、重复文件、无哈希都不能发布', () => {
  const r = release();
  assert.throws(() => plan({ ...r, assets: r.assets.slice(0, 1) }), /缺少/);
  assert.throws(() => plan({ ...r, assets: [...r.assets, r.assets[0]] }), /重复/);
  assert.throws(() => plan({ ...r, assets: r.assets.map((a) => ({ ...a, digest: null })) }), /SHA-256/);
  assert.throws(() => plan({ ...r, assets: r.assets.map((a) => ({ ...a, name: `old-${a.name}` })) }), /缺少/);
});

test('私有仓库默认不公开仓库名、内部说明、API 下载地址和 asset ID', () => {
  const result = plan().publicRelease;
  const text = JSON.stringify(result);
  for (const secret of ['owner/private', 'INTERNAL', 'assetId', 'api.github.com']) assert.equal(text.includes(secret), false);
  assert.equal(result.notes, '');
  assert.equal(result.files[0].url, 'https://download.caibao.media/recorder/0.2.2/win-0.2.2.exe');
});

test('同版本文件改变时拒绝覆盖，重复运行接受同一哈希', () => {
  const old = plan().publicRelease;
  assert.deepEqual(plan(release(), old).publicRelease, old);
  const changed = release(); changed.assets[0].digest = `sha256:${'a'.repeat(64)}`;
  assert.throws(() => plan(changed, old), /发生变化/);
});

test('传输中断、超长、短文件、错误哈希均删除未完成文件', async (t) => {
  const dir = await temp(t);
  const expected = { size: content.length, sha256: hash };
  for (const [name, body, meta] of [
    ['short', Readable.from(['short']), expected],
    ['oversize', Readable.from([content, 'extra']), expected],
    ['hash', Readable.from([content]), { ...expected, sha256: '0'.repeat(64) }],
    ['disconnect', Readable.from((async function* () { yield 'abc'; throw new Error('network disconnected'); })()), expected],
  ]) {
    const path = join(dir, name);
    await assert.rejects(verifyStream(body, path, meta));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  const path = join(dir, 'valid');
  const { md5 } = await verifyStream(Readable.from([content]), path, expected);
  assert.deepEqual(await readFile(path), content);
  assert.equal(md5, createHash('md5').update(content).digest('base64'));
});

test('一端上传失败时不发布清单，成功后整体替换且读者始终读到完整 JSON', async (t) => {
  const path = join(await temp(t), 'catalog.json');
  const old = { schemaVersion: 1, products: { recorder: { version: 'v0.2.1' } } };
  await atomicJson(path, old);
  let count = 0;
  await assert.rejects(publishProduct(plan(), async () => { if (++count === 2) throw new Error('COS failed'); }));
  assert.deepEqual(await readCatalog(path), old);
  const published = await publishProduct(plan(), async () => {});
  await atomicJson(path, { schemaVersion: 1, products: { recorder: published } });
  assert.equal((await readCatalog(path)).products.recorder.version, 'v0.2.2');
});

test('损坏的旧清单不能被当作空清单覆盖', async (t) => {
  const path = join(await temp(t), 'catalog.json');
  assert.deepEqual(await readCatalog(path), { schemaVersion: 1, products: {} });
  await writeFile(path, '{broken');
  await assert.rejects(readCatalog(path));
});

test('重试复用校验通过的缓存，损坏缓存会重新下载', async (t) => {
  const dir = await temp(t);
  const asset = { name: 'file.exe', size: content.length, sha256: hash };
  let calls = 0;
  const download = (path) => { calls++; return verifyStream(Readable.from([content]), path, asset); };
  const first = await cachedAsset(dir, asset, download);
  await cachedAsset(dir, asset, download);
  assert.equal(calls, 1);
  await writeFile(first.path, 'bad');
  await cachedAsset(dir, asset, download);
  assert.equal(calls, 2);
});

test('配置拒绝路径穿越和重复产品，默认有效', () => {
  assert.doesNotThrow(() => validateConfig({ schemaVersion: 1, products: [product] }));
  assert.throws(() => validateConfig({ schemaVersion: 1, products: [product, product] }));
  assert.throws(() => validateConfig({ schemaVersion: 1, products: [{ ...product, slug: '../other' }] }));
  assert.throws(() => planRelease(product, release(), 'http://download.caibao.media'));
  assert.throws(() => planRelease(product, release(), 'https://user:password@download.caibao.media'));
});


test('所有文件先完成上传，公开下载失败仍保留旧版本', async () => {
  const order = [], current = plan(), old = { version: '0.2.1' };
  let visible = old;
  await assert.rejects(async () => {
    visible = await publishProduct(current,
      async asset => order.push(`upload:${asset.id}`),
      async asset => { order.push(`public:${asset.id}`); throw new Error('HTTPS unavailable'); });
  }, /HTTPS unavailable/);
  assert.deepEqual(order, ['upload:win', 'upload:mac', 'public:win']);
  assert.equal(visible, old);
  const success = [];
  visible = await publishProduct(current,
    async asset => success.push(`upload:${asset.id}`),
    async asset => success.push(`public:${asset.id}`));
  assert.deepEqual(success, ['upload:win', 'upload:mac', 'public:win', 'public:mac']);
  assert.equal(visible, current.publicRelease);
});
