import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendFile } from '../server/http-response.js';
import { listenLocal } from '../server/local-endpoint.js';

test('workbench file responses preserve byte ranges and HEAD without sending extra data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-file-response-'));
  const file = path.join(root, 'fixture.js');
  await fs.writeFile(file, '0123456789');
  const server = http.createServer((request, response) => {
    sendFile(request, response, file).catch(error => response.destroy(error));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const port = await listenLocal(server, 0);
  const url = `http://127.0.0.1:${port}/fixture.js`;
  const partial = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.equal(await partial.text(), '2345');

  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal(await head.text(), '');

  const missing = await fetch(url, { headers: { Range: 'bytes=10-' } });
  assert.equal(missing.status, 416);
  assert.equal(missing.headers.get('content-range'), 'bytes */10');
  assert.equal(await missing.text(), '');
});
