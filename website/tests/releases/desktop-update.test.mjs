import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { planRelease, publishProduct, validateConfig } from '../../scripts/release-core.mjs';
import { verifyDesktopUpdate } from '../../scripts/desktop-update.mjs';
import { UPDATE_KEY_ID } from '../../scripts/update-trust.mjs';

const product = { slug: 'caibo-recorder', repository: 'owner/recorder', desktopUpdate: { fromVersion: '0.2.3' }, files: [
  { id: 'win-setup', platform: 'windows', arch: 'x64', name: 'win-{version}.exe' },
  { id: 'mac-dmg', platform: 'macos', arch: 'arm64', name: 'mac-{version}.dmg' },
] };
function release(version = '0.2.3') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-16T00:00:00Z', target_commitish: 'a'.repeat(40), assets: [`win-${version}.exe`, `mac-${version}.dmg`, 'caibao-update.json'].map((name, index) => ({ id: index + 1, name, state: 'uploaded', size: 100 + index, digest: `sha256:${String(index).repeat(64)}` })) };
}
const plan = value => planRelease(product, value, 'https://download.caibao.media');

test('旧版保持网站镜像，新版必须同时具备签名更新附件才发布', () => {
  assert.equal(plan(release('0.2.2')).assets.length, 2);
  const next = release(); assert.equal(plan(next).assets.length, 3);
  assert.throws(() => plan({ ...next, assets: next.assets.slice(0, 2) }), /缺少/);
  assert.throws(() => validateConfig({ schemaVersion: 1, products: [{ ...product, desktopUpdate: { fromVersion: '../x' } }] }));
});
test('桌面更新签名绑定两端安装包和精确源码，不接受被改写的清单', async () => {
  const keys = generateKeyPairSync('ed25519'), p = plan(release());
  const manifest = { schema: 1, version: '0.2.3', sourceRevision: 'a'.repeat(40), notes: ['更新'], platforms: Object.fromEntries([['win32-x64', 'win-setup'], ['darwin-arm64', 'mac-dmg']].map(([platform, id]) => {
    const item = p.assets.find(asset => asset.id === id); return [platform, { name: item.name, size: item.size, sha256: item.sha256 }];
  })) };
  const envelopeFor = value => { const bytes = Buffer.from(JSON.stringify(value)); return { schema: 1, keyId: UPDATE_KEY_ID, data: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') }; };
  const envelope = envelopeFor(manifest);
  assert.equal(verifyDesktopUpdate(envelope, p, keys.publicKey).version, '0.2.3');
  for (const mutate of [m => m.version = '0.2.4', m => m.sourceRevision = 'b'.repeat(40), m => m.platforms['win32-x64'].size++, m => delete m.platforms['darwin-arm64']]) {
    const changed = structuredClone(manifest); mutate(changed); assert.throws(() => verifyDesktopUpdate(envelopeFor(changed), p, keys.publicKey));
  }
  assert.throws(() => verifyDesktopUpdate({ ...envelope, signature: Buffer.alloc(64).toString('base64') }, p, keys.publicKey));
  let visible = false;
  await assert.rejects(publishProduct(p, async asset => { if (asset.id === 'mac-dmg') throw new Error('not uploaded'); }).then(() => { visible = true; }));
  assert.equal(visible, false);
});
