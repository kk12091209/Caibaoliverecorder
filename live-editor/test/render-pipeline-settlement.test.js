import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Media } from '../server/media.js';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  // An invalid pid prevents Media from changing any real process priority.
  child.pid = Number.NaN;
  child.stdin.resume();
  let closing = false;
  child.didClose = false;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill = () => {
    if (!closing) {
      closing = true;
      setTimeout(() => {
        child.stdin.destroy();
        child.stdout.end();
        child.stderr.end();
        child.didClose = true;
        child.emit('close', 1, 'SIGTERM');
      }, 30);
    }
    return true;
  };
  const media = {
    closed: false,
    ffmpeg: 'unused-fake-ffmpeg',
    children: new Set(),
    backgroundChildren: new Set(),
    spawnTracked: () => child,
  };
  return { child, media, closed };
}

function observeSettlement(promise, fixture) {
  return promise.then(
    () => ({ status: 'fulfilled' }),
    error => ({ status: 'rejected', error }),
  ).then(result => ({
    ...result,
    childClosed: fixture.child.didClose,
    children: fixture.media.children.size,
    backgroundChildren: fixture.media.backgroundChildren.size,
  }));
}

function assertChildSettled(result) {
  assert.equal(result.childClosed, true, 'process must remain pending until the child emits close');
  assert.equal(result.children, 0, 'foreground process tracking must be cleared before settlement');
  assert.equal(result.backgroundChildren, 0, 'background process tracking must be cleared before settlement');
}

test('输入读盘异常必须等待被终止的子进程 close 后才 reject 并释放进程集合', { timeout: 3000 }, async () => {
  const fixture = fakeProcess();
  const readError = Object.assign(new Error('读取素材时发生读盘异常'), { code: 'EIO' });
  async function* brokenInput() {
    yield Buffer.from('partial video');
    throw readError;
  }
  const operation = observeSettlement(Media.prototype.process.call(fixture.media, [], {
    input: brokenInput(), background: true,
  }), fixture);
  assert.equal(fixture.media.children.has(fixture.child), true);
  assert.equal(fixture.media.backgroundChildren.has(fixture.child), true);
  const [result] = await Promise.all([operation, fixture.closed]);
  assert.equal(result.status, 'rejected');
  assert.ok(result.error instanceof Error);
  assertChildSettled(result);
});

test('AbortSignal 取消后仍等待延迟到达的 child close，不能提前释放后台任务', { timeout: 3000 }, async () => {
  const fixture = fakeProcess(), controller = new AbortController();
  const inputFinished = once(fixture.child.stdin, 'finish');
  async function* input() { yield Buffer.from('video'); }
  const operation = observeSettlement(Media.prototype.process.call(fixture.media, [], {
    input: input(), signal: controller.signal, background: true,
  }), fixture);
  await inputFinished;
  assert.equal(fixture.media.children.has(fixture.child), true);
  assert.equal(fixture.media.backgroundChildren.has(fixture.child), true);
  controller.abort();
  const [result] = await Promise.all([operation, fixture.closed]);
  assertChildSettled(result);
});

test('child error 先到而 close 延迟时，process 不得提前 reject', { timeout: 3000 }, async () => {
  const fixture = fakeProcess();
  const operation = observeSettlement(Media.prototype.process.call(fixture.media, [], {
    background: true,
  }), fixture);
  fixture.child.emit('error', new Error('子进程管道异常'));
  fixture.child.kill();
  const [result] = await Promise.all([operation, fixture.closed]);
  assert.equal(result.status, 'rejected');
  assert.ok(result.error instanceof Error);
  assertChildSettled(result);
});
