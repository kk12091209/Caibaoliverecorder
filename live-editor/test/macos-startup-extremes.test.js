import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('Mac extreme startup faults remain bounded, recoverable and preserve user data', { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
  const root = await fs.mkdtemp('/private/tmp/caibo-startup-extremes-'), sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body || '{}');
    // Find the fixture associated with this controller's PID/client heartbeat.
    if (!request.client) { res.writeHead(403); res.end('{}'); return; }
    const fixtures = await fs.readdir(root, { withFileTypes: true });
    let target;
    for (const fixture of fixtures.filter(x => x.isDirectory())) {
      const data = path.join(root, fixture.name, 'data');
      const mode = await fs.readFile(path.join(data, 'mode'), 'utf8').catch(() => null);
      if (!mode) continue;
      const endpoint = JSON.parse(await fs.readFile(path.join(data, 'desktop-service.json'), 'utf8').catch(() => '{}'));
      if (endpoint.fixtureClient === request.client) { target = { data, mode }; break; }
    }
    if (!target || target.mode === 'stall') return;
    if (target.mode === '503') { res.writeHead(503); res.end('{}'); return; }
    if (target.mode === 'bad-json') { res.writeHead(200); res.end('{'); return; }
    const endpoint = JSON.parse(await fs.readFile(path.join(target.data, 'desktop-service.json')));
    assert.equal(req.headers['x-caibo-instance'], endpoint.token);
    const { token, ...status } = endpoint;
    if (target.mode === 'wrong-instance') status.instance = 'c'.repeat(32);
    if (target.mode === 'wrong-data') status.dataPath += '-wrong';
    if (target.mode === 'old-busy') status.build = 'old';
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...status, busy: target.mode === 'old-busy', stopping: false, background: false }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const source = fileURLToPath(new URL('../desktop-macos/App.swift', import.meta.url));
    const original = await fs.readFile(source, 'utf8');
    assert.equal(original.split('lastStatus = try await backend.ensure();').length, 2);
    await fs.writeFile(path.join(root, 'App.swift'), original.split('@main struct CaiboMain {')[0].replace('lastStatus = try await backend.ensure();', 'lastStatus = try await backend.ensure(timeout: 0.35);'));
    const backend = await fs.readFile(fileURLToPath(new URL('../desktop-macos/Backend.swift', import.meta.url)), 'utf8');
    assert.ok(backend.includes('protectedStateSince < 120'));
    // Keep production save-stage protection; accelerate only the invalid-clock observation.
    await fs.writeFile(path.join(root, 'Backend.swift'), backend.replace('protectedStateSince < 120', 'protectedStateSince < 0.12'));
    const env = { ...process.env, TMPDIR: '/private/tmp', TMP: '/private/tmp', TEMP: '/private/tmp' }, executable = path.join(root, 'checks');
    await run('xcrun', ['swiftc', '-swift-version', '5', '-module-cache-path', path.join(root, 'modules'), ...['ProcessOwnership.swift', 'Repair.swift'].map(x => fileURLToPath(new URL('../desktop-macos/' + x, import.meta.url))), path.join(root, 'Backend.swift'), path.join(root, 'App.swift'), fileURLToPath(new URL('./helpers/macos-startup-extremes.swift', import.meta.url)), '-o', executable], { env, timeout: 45000 });
    const { stdout } = await run(executable, [root, `http://127.0.0.1:${server.address().port}`], { env, timeout: 25000 });
    assert.equal(stdout.match(/^PASS /gm)?.length, 51, stdout);
    if (process.env.CAIBO_TEST_EVIDENCE) await fs.writeFile(process.env.CAIBO_TEST_EVIDENCE, stdout);
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
