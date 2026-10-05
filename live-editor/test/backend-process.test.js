import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

for (const action of ['exit', 'quit']) test(`standalone backend releases its process after ${action}, despite a lingering handle`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-process-exit-'));
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  const sentinel = path.join(data, 'keep-recording.bin');
  await fs.writeFile(sentinel, 'synthetic recording must remain');
  const preload = path.join(root, 'keep-alive.mjs');
  await fs.writeFile(preload, 'setInterval(() => {}, 60000);\n');
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: {...process.env, NO_RECORDER: '1', EDITOR_DATA: data, EDITOR_PROJECT_ROOT: root,
      EDITOR_PORT: '0', EDITOR_DESKTOP_MANAGED: '1', FFMPEG_PATH: process.execPath, FFPROBE_PATH: process.execPath}
  });
  let stderr = ''; child.stderr.on('data', value => {stderr = (stderr + value).slice(-4096);});
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {child.kill(); await exited;}
    await fs.rm(root, {recursive: true, force: true});
  });
  let endpoint;
  for (let n = 0; n < 200; n++) {
    try {endpoint = JSON.parse(await fs.readFile(path.join(data, 'desktop-service.json'), 'utf8')); break;} catch {}
    assert.equal(child.exitCode, null, stderr);
    await delay(50);
  }
  assert.ok(endpoint, 'backend did not become ready: ' + stderr);
  const response = await fetch(endpoint.origin + '/internal/desktop', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Caibo-Instance': endpoint.token},
    body: JSON.stringify({action, confirmed: true})});
  assert.equal(response.status, 200);
  await response.json();
  const result = await Promise.race([exited, delay(10000).then(() => null)]);
  assert.deepEqual(result, [0, null], 'clean shutdown did not release the process: ' + stderr);
  await assert.rejects(fs.stat(path.join(data, 'desktop-service.json')), {code: 'ENOENT'});
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'synthetic recording must remain');
});
