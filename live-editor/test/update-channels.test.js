import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Store } from '../server/store.js';
import { Updates, CAIBAO_UPDATE_URL, UPDATE_REPOSITORY, packageName, caibaoFetch, validateMirrorUpdate } from '../server/updates.js';
import { UPDATE_KEY_ID } from '../server/update-trust.js';

const keys = generateKeyPairSync('ed25519');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const current = { version: '0.2.2' };
const signed = manifest => {
  const data = Buffer.from(JSON.stringify(manifest));
  return { schema: 1, keyId: UPDATE_KEY_ID, data: data.toString('base64'), signature: sign(null, data, keys.privateKey).toString('base64') };
};
async function fixture(t, platform = 'win32-x64') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-channels-'));
  const store = new Store(root), calls = [], modes = {};
  const payloads = new Map(['win32-x64', 'darwin-arm64'].map(id => [packageName('0.2.3', id), Buffer.from(`verified ${id} package`)]));
  const manifest = { schema: 1, version: '0.2.3', revision: 1, notes: ['双渠道更新'], platforms: Object.fromEntries([...payloads].map(([name, bytes], index) => [['win32-x64', 'darwin-arm64'][index], { name, size: bytes.length, sha256: digest(bytes) }])) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const assets = new Map([['update-manifest.json', manifestBytes], ...payloads]);
  const release = { tag_name: 'v0.2.3', draft: false, prerelease: false, assets: [...assets].map(([name, bytes]) => ({ name, size: bytes.length, state: 'uploaded', digest: `sha256:${digest(bytes)}`, browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.2.3/${name}` })) };
  const stall = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const fetcher = async (url, { signal } = {}) => {
    calls.push(url);
    if (url === CAIBAO_UPDATE_URL) {
      if (modes.check === 'timeout') return stall(signal);
      if (modes.check === 'offline') throw new Error('primary unavailable');
      const envelope = signed(manifest);
      if (modes.check === 'tampered') envelope.signature = Buffer.alloc(64).toString('base64');
      return Response.json(envelope);
    }
    if (url.startsWith('https://download.caibao.media/')) {
      if (modes.download === 'offline') throw new Error('primary unavailable');
      if (modes.download === 'timeout') return stall(signal);
      if (modes.download === 'stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); } }));
      return new Response(null, { status: 302, headers: { location: url.replace('download.caibao.media', 'caibao-releases-1393257344.cos.ap-singapore.myqcloud.com') } });
    }
    const name = new URL(url).pathname.split('/').at(-1);
    if (url.includes('.myqcloud.com/')) return new Response(modes.download === 'corrupt' ? Buffer.alloc(payloads.get(name).length) : payloads.get(name));
    if (url.startsWith('https://api.github.com/')) return modes.github === 'limited' ? new Response(null, { status: 429, headers: { 'retry-after': '3600' } }) : modes.github === 'offline' ? new Response(null, { status: 503 }) : Response.json(release);
    if (url.startsWith('https://github.com/')) return new Response(modes.github === 'corrupt' && name !== 'update-manifest.json' ? Buffer.alloc(payloads.get(name).length) : assets.get(name));
    throw new Error('Unexpected request: ' + url);
  };
  let now = 200000;
  const updates = new Updates(store, { current, platform, fetcher, mirrorPublicKey: keys.publicKey, mirrorTimeoutMs: 100, idleMs: 100, now: () => now });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(async () => { clearInterval(keepAlive); await updates.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { updates, calls, modes, manifest, payloads, advance: ms => { now += ms; } };
}
async function download(f) { await f.updates.check(); f.updates.download(f.updates.candidate.key, true); await f.updates.downloadTask; }

test('两端优先使用签名自有源，下载通过固定 COS 跳转，不联系 GitHub', async t => {
  for (const platform of ['win32-x64', 'darwin-arm64']) {
    const f = await fixture(t, platform); await download(f);
    assert.equal(f.updates.status, 'ready');
    assert.deepEqual(await fs.readFile(await f.updates.installPath()), f.payloads.get(packageName('0.2.3', platform)));
    assert.equal(f.calls[0], CAIBAO_UPDATE_URL);
    assert.ok(f.calls.every(url => !url.includes('github.com')));
    assert.equal(f.updates.snapshot().autoInstall, true);
    assert.equal(f.updates.snapshot().candidate.fallbackUrl, undefined);
  }
});
test('自有源断网、超时或签名损坏时自动通过 GitHub 检查更新', async t => {
  for (const mode of ['offline', 'timeout', 'tampered']) {
    const f = await fixture(t); f.modes.check = mode; await download(f);
    assert.equal(f.updates.status, 'ready');
    assert.ok(f.calls[1].startsWith('https://api.github.com/'));
    assert.ok(!f.calls.some(url => url.startsWith('https://download.caibao.media/')));
  }
});
test('自有源安装包失败、无进展或哈希错误后，备用源仍下载同版本同哈希文件', async t => {
  for (const mode of ['offline', 'timeout', 'corrupt']) {
    const f = await fixture(t); f.modes.download = mode; await download(f);
    assert.equal(f.updates.status, 'ready');
    assert.ok(f.calls.at(-1).endsWith('/v0.2.3/BiliLiveEditor-0.2.3-win-x64-setup.exe'));
    assert.deepEqual(await fs.readFile(await f.updates.installPath()), f.payloads.get(packageName('0.2.3', 'win32-x64')));
    assert.deepEqual(await fs.readdir(f.updates.root), [f.updates.candidate.name]);
  }
});
test('取消主渠道下载不触发备用下载；两个渠道校验都失败时不能安装', async t => {
  const f = await fixture(t); f.modes.download = 'stream'; await f.updates.check(); f.updates.download(f.updates.candidate.key);
  while (!f.updates.received) await new Promise(resolve => setTimeout(resolve, 1));
  f.updates.cancel(); await f.updates.downloadTask;
  assert.ok(!f.calls.some(url => url.startsWith('https://github.com/')));
  assert.equal(f.updates.ready, null); assert.deepEqual(await fs.readdir(f.updates.root), []);
  const g = await fixture(t); g.modes.download = 'corrupt'; g.modes.github = 'corrupt'; await download(g);
  assert.equal(g.updates.ready, null); assert.equal(g.updates.status, 'available');
  await assert.rejects(g.updates.installPath());
});
test('两个检查渠道都失败不误报最新；GitHub 限流不阻止随后恢复的主渠道', async t => {
  const f = await fixture(t); f.modes.check = 'offline'; f.modes.github = 'limited'; await f.updates.check();
  assert.equal(f.updates.status, 'error'); assert.equal(f.updates.checkedAt, 0);
  assert.ok(f.updates.retryAt > 0);
  f.modes.check = undefined; f.advance(10000); await f.updates.check();
  assert.equal(f.updates.status, 'available'); assert.equal(f.updates.error, '');
  assert.equal(f.updates.retryAt, 0);
});
test('校验绑定发布密钥、版本、架构和固定目标，拒绝恶意跳转', async t => {
  const f = await fixture(t), envelope = signed(f.manifest);
  assert.equal(validateMirrorUpdate(envelope, { version: '0.2.3' }, 'win32-x64', keys.publicKey), null);
  assert.throws(() => validateMirrorUpdate(envelope, current, 'linux-x64', keys.publicKey));
  assert.throws(() => validateMirrorUpdate({ ...envelope, data: envelope.data + '=' }, current, 'win32-x64', keys.publicKey));
  assert.throws(() => validateMirrorUpdate(envelope, current, 'win32-x64', generateKeyPairSync('ed25519').publicKey));
  for (const location of ['http://127.0.0.1/private', 'https://evil.example/file', 'https://caibao-releases-1393257344.cos.ap-singapore.myqcloud.com/another/file.exe']) {
    const calls = [];
    await assert.rejects(caibaoFetch('https://download.caibao.media/caibo-recorder/0.2.3/BiliLiveEditor-0.2.3-win-x64-setup.exe', { fetcher: async url => { calls.push(url); return new Response(null, { status: 302, headers: { location } }); } }));
    assert.equal(calls.length, 1);
  }
});
test('菜包宇宙链接在 Windows、Mac 桌面桥和浏览器中打开固定官网', async () => {
  const source = (await fs.readFile(new URL('../src/desktop.js', import.meta.url), 'utf8')).replace(/export /g, '');
  for (const platform of ['windows', 'mac', 'browser']) {
    const messages = [], opened = [];
    const window = { addEventListener() {}, open: (...args) => opened.push(args) };
    if (platform === 'windows') window.chrome = { webview: { addEventListener() {}, postMessage: value => messages.push(value) } };
    if (platform === 'mac') window.webkit = { messageHandlers: { caibo: { postMessage: value => messages.push(value) } } };
    vm.runInNewContext(source + '\nopenStudioPage();', { window, setTimeout, clearTimeout });
    if (platform === 'browser') assert.equal(opened[0][0], 'https://www.caibao.media/');
    else { assert.equal(messages[0].action, 'openExternal'); assert.equal(messages[0].url, 'https://www.caibao.media/'); assert.equal(opened.length, 0); }
  }
});
