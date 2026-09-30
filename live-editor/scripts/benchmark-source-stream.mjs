// Dot-source scripts/dev-env.ps1 first. Transport microbenchmark only: no
// encoding, no network, and no production Store or recording is accessed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { transportFixture, baselineSourceStream, sourceStream } from '../test/helpers/source-stream-fixture.js';

const seconds = Math.max(2, Math.min(120, Number(process.argv[2]) || 20));
const rounds = Math.max(1, Math.min(10, Number(process.argv[3]) || 4));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-stream-benchmark-'));
let fixture;
const childCode = `const c=require('node:crypto').createHash('sha256');let bytes=0;process.stdin.on('data',b=>{bytes+=b.length;c.update(b)});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes,hash:c.digest('hex')})));`;
try {
  fixture = await transportFixture(root, { seconds });
  const { store, source } = fixture;
  async function measure(name, stream) {
    const child = spawn(process.execPath, ['-e', childCode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let response = '', errors = '', blocks = 0;
    child.stdout.on('data', data => { response += data; }); child.stderr.on('data', data => { errors += data; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(errors || `child exit ${code}`))); });
    async function* counted() { for await (const block of stream(store, source.id, source.start, source.start + seconds)) { blocks++; yield block; } }
    const cpu = process.cpuUsage(), started = performance.now();
    await Promise.all([pipeline(Readable.from(counted()), child.stdin), done]);
    const cpuTime = process.cpuUsage(cpu), output = JSON.parse(response);
    return { name, elapsedMs: Math.round(performance.now() - started), cpuMs: Math.round((cpuTime.user + cpuTime.system) / 1000), blocks, ...output };
  }
  // Warm both paths, then alternate order to reduce cache/order bias.
  const reference = await measure('warm-baseline', baselineSourceStream);
  assert.equal((await measure('warm-batched', sourceStream)).hash, reference.hash);
  const results = [];
  for (let round = 0; round < rounds; round++) for (const [name, stream] of round % 2 ? [['batched', sourceStream], ['baseline', baselineSourceStream]] : [['baseline', baselineSourceStream], ['batched', sourceStream]]) {
    const result = await measure(name, stream); assert.equal(result.hash, reference.hash); assert.equal(result.bytes, reference.bytes); results.push(result);
  }
  const summary = Object.fromEntries(['baseline', 'batched'].map(name => {
    const rows = results.filter(row => row.name === name), median = field => rows.map(row => row[field]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    return [name, { medianMs: median('elapsedMs'), medianCpuMs: median('cpuMs'), blocks: rows[0].blocks, bytes: rows[0].bytes }];
  }));
  console.log(JSON.stringify({ kind: 'synthetic FLV compressed-byte pipe; no decode or encode', seconds, rounds, summary, results }, null, 2));
} finally {
  fixture?.ingest.stop(); fixture?.store.close();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('bili-stream-benchmark-'));
  await fs.rm(root, { recursive: true, force: true });
}
