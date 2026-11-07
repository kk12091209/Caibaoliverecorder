import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Pass the standalone Windows FFmpeg component directory.');
const pinned = JSON.parse(await fs.readFile(new URL('./release-runtime.json', import.meta.url))).windows.ffmpeg;
const manifest = JSON.parse(await fs.readFile(path.join(root, 'component.json'), 'utf8'));
assert.equal(manifest.version, pinned.version);
assert.equal(manifest.variant, pinned.variant);
assert.deepEqual(manifest.source, pinned.source);
assert.deepEqual(manifest.toolchain, pinned.toolchain);
const bin = path.join(root, 'bin');
const files = new Set();
for (const item of manifest.files) {
  assert.match(item.name, /^[A-Za-z0-9_.+-]+\.(dll|exe)$/i);
  const name = item.name.toLowerCase();
  assert.ok(!files.has(name), `Duplicate FFmpeg component: ${name}`);
  files.add(name);
  const file = path.join(bin, item.name);
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && stat.size === item.bytes, `Invalid component file: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest('hex'), item.sha256, `FFmpeg checksum mismatch: ${name}`);
}
for (const entry of await fs.readdir(bin)) {
  assert.ok(files.has(entry.toLowerCase()), `Unlisted file in FFmpeg bin: ${entry}`);
}
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) assert.ok(files.has(name), `Missing ${name}`);
for (const name of ['LICENSE', 'README.txt', 'config.mak']) {
  assert.ok((await fs.stat(path.join(root, name))).isFile(), `Missing FFmpeg notice: ${name}`);
}
console.log(`Verified FFmpeg ${manifest.version}, ${files.size} binaries and build notices.`);
