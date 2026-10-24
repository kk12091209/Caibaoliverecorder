import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Media } from '../server/media.js';

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
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
  const media = Object.assign(Object.create(Media.prototype), {
    closed: false,
    ffmpeg: 'unused-fake-ffmpeg',
    children: new Set(),
    backgroundChildren: new Set(),
    interactiveChildren: new Set(),
    spawnTracked: () => child,
  });
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
  assert.equal(result.interactiveChildren??0,0,'interactive process tracking must be cleared before settlement');
}

test('实际预览进程登记为并行任务，仍受清理保护且退出后释放登记',async()=>{
  const {media,child}=fakeProcess();
  Object.assign(media,{processing:false,enqueues:new Set(),previews:new Map(),probes:new Set(),saves:new Map(),savePreparations:new Set()});
  const operation=Media.prototype.process.call(media,[],{interactive:true});
  await Promise.resolve();
  assert.equal(media.interactiveChildren.has(child),true);
  assert.equal(Media.prototype.hasForegroundWork.call(media),true);
  assert.equal(Media.prototype.hasForegroundWork.call(media,{includeInteractive:false}),false);
  child.kill();await assert.rejects(operation,/视频处理失败/);
  assert.equal(media.interactiveChildren.size,0);assert.equal(media.children.size,0);
});

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
  await Promise.resolve();
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
  await Promise.resolve();
  fixture.child.emit('error', new Error('子进程管道异常'));
  fixture.child.kill();
  const [result] = await Promise.all([operation, fixture.closed]);
  assert.equal(result.status, 'rejected');
  assert.ok(result.error instanceof Error);
  assertChildSettled(result);
});

test('取消时源已结束但 stdin 尚未 finish，仍显式关闭输入并等 child close', {timeout:3000}, async()=>{
  const fixture=fakeProcess(),controller=new AbortController();let finalEntered;
  const flushing=new Promise(resolve=>{finalEntered=resolve;});
  fixture.child.stdin=new Writable({write(_bytes,_encoding,done){done();},final(){finalEntered();}});
  fixture.child.stdio[0]=fixture.child.stdin;
  async function* input(){yield Buffer.from('complete source with a destination still flushing');}
  const operation=observeSettlement(Media.prototype.process.call(fixture.media,[],{input:input(),signal:controller.signal,background:true}),fixture);
  await flushing;controller.abort();assert.equal(fixture.child.stdin.destroyed,true);
  const result=await operation;assertChildSettled(result);
});

test('取消已读到结尾但仍有背压的输入，不能等待销毁后不会再发出的 end', {timeout:3000}, async()=>{
  const fixture=fakeProcess(),controller=new AbortController();let finishRead;
  fixture.child.stdin=new Writable({highWaterMark:1,write(){}});
  fixture.child.stdio[0]=fixture.child.stdin;
  const read=new Promise(resolve=>{finishRead=resolve;});
  async function* input(){try{for(let i=0;i<4;i++)yield Buffer.alloc(1024);}finally{finishRead();}}
  const operation=observeSettlement(Media.prototype.process.call(fixture.media,[],{input:input(),signal:controller.signal,background:true}),fixture);
  await read;await new Promise(resolve=>setImmediate(resolve));controller.abort();
  const result=await operation;assertChildSettled(result);
});
