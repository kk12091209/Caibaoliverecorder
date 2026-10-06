import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('Mac startup retry reports progress, recovers late backends, and limits owned-process recovery', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const root = await fs.mkdtemp('/private/tmp/caibo-startup-recovery-');
  const sockets = new Set();
  const data = path.join(root, 'data'), editor = path.join(root, 'resources/live-editor');
  const endpoint = { protocol: 1, instance: 'a'.repeat(32), token: 'b'.repeat(64), pid: process.pid, dataPath: data };
  const server = http.createServer((req, res) => {
    if (req.url === '/internal/desktop') {
      if (!existsSync(path.join(root, 'healthy'))) { writeFileSync(path.join(root, 'blocked-request'), '1'); return; }
      if (req.headers['x-caibo-instance'] !== endpoint.token) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Production responses do not contain the authentication token.
      const { token, ...status } = endpoint;
      res.end(JSON.stringify({ ...status, stopping: false, background: false, busy: false }));
    } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<div id="app"></div>'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint.origin = 'http://127.0.0.1:' + server.address().port;
    for (const dir of [data, path.join(editor, 'server'), path.join(editor, 'dist/assets')]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(editor, 'package.json'), '{}');
    await fs.writeFile(path.join(editor, 'server/index.js'), '// test fixture');
    await fs.writeFile(path.join(editor, 'dist/index.html'), '<div id="app"></div><script src="/assets/app.js"></script>');
    await fs.writeFile(path.join(editor, 'dist/assets/app.js'), '// fixture');
    for (const name of ['node/node', 'recorder/BililiveRecorder.Cli', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) { const file = path.join(root, 'resources/runtime', name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile('/usr/bin/true', file); }
    for (const name of ['BililiveRecorder.Cli.dll', 'BililiveRecorder.Core.dll', 'BililiveRecorder.Cli.deps.json', 'BililiveRecorder.Cli.runtimeconfig.json', 'libhostfxr.dylib', 'libcoreclr.dylib']) await fs.writeFile(path.join(root, 'resources/runtime/recorder', name), 'fixture');
    await fs.writeFile(path.join(data, 'existing-recording.flv'), 'existing recording');
    const hash = createHash('sha256');
    for (const name of ['package.json', 'server/index.js']) hash.update(name + '\n').update(await fs.readFile(path.join(editor, name))).update('\0');
    endpoint.build = hash.digest('hex');
    await fs.writeFile(path.join(data, 'desktop-service.json'), JSON.stringify(endpoint));
    const appSource = fileURLToPath(new URL('../desktop-macos/App.swift', import.meta.url));
    const original = await fs.readFile(appSource, 'utf8');
    const needle = 'lastStatus = try await backend.ensure();';
    assert.equal(original.split(needle).length, 2);
    // Only shorten the waiting deadline; all retry/recovery/UI code is original.
    await fs.writeFile(path.join(root, 'App.swift'), original.split('@main struct CaiboMain {')[0].replace(needle, 'lastStatus = try await backend.ensure(timeout: 0.3);'));
    const env = { ...process.env, TMPDIR: '/private/tmp', TMP: '/private/tmp', TEMP: '/private/tmp' };
    const executable = path.join(root, 'checks');
    await run('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', path.join(root, 'modules'), fileURLToPath(new URL('../desktop-macos/ProcessOwnership.swift', import.meta.url)), fileURLToPath(new URL('../desktop-macos/Repair.swift', import.meta.url)), fileURLToPath(new URL('../desktop-macos/Backend.swift', import.meta.url)), path.join(root, 'App.swift'), fileURLToPath(new URL('./helpers/macos-startup-recovery.swift', import.meta.url)), '-o', executable], { env, timeout: 45000 });
    const { stdout } = await run(executable, [root, process.execPath], { env, timeout: 10000 });
    assert.equal(stdout.match(/^PASS /gm)?.length, 8, stdout);
    assert.ok(!stdout.includes(endpoint.token));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
