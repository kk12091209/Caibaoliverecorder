import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.js';
import { Ingestor } from '../server/ingest.js';

const message = (time, text) => `<d p="${time},1,25,16777215" user="测试">${text}</d>`;
async function setup(t, xml) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-ingest-finalization-'));
  const store = new Store(path.join(root, 'database'));
  const session = store.createSession({ status: 'finished' });
  const source = store.addSource(session.id, path.join(root, 'source.flv'), 0, new Date().toISOString(), true);
  store.run('UPDATE sources SET closed=2,duration=10 WHERE id=?', source.id);
  source.closed = 2;
  if (xml !== undefined) await fs.writeFile(source.xml, xml);
  let now = 0;
  const ingestor = new Ingestor(store, { now: () => now });
  t.after(async () => {
    ingestor.stop(); store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('bili-ingest-finalization-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, session, source, ingestor, advance(value) { now = value; } };
}

test('闭合且读至末尾的 XML 只扫描一次，未自动归档也不会持续打开文件', async t => {
  const { store, session, source, ingestor } = await setup(t, '<i>' + message(1, '已完成') + '</i>');
  const open = fs.open; let opens = 0;
  t.mock.method(fs, 'open', async (file, ...args) => { if (file === source.xml) opens++; return open(file, ...args); });
  await ingestor.tick(); await ingestor.tick(); await ingestor.tick();
  assert.equal(opens, 1);
  assert.equal(store.messages(session.id).length, 1);
  assert.equal(store.session(session.id).archive_status, 'pending');
  assert.equal(ingestor.states.size, 0);
  assert.equal(ingestor.xmlStates.get(source.id).complete, true);
  const restarted = new Ingestor(store);
  await restarted.tick(); await restarted.tick();
  assert.equal(opens, 2);
  assert.equal(store.messages(session.id).length, 1);
});

test('没有闭合尾部的 XML 静默后低频重试，迟到弹幕和最终闭合仍会收齐', async t => {
  const { store, session, source, ingestor, advance } = await setup(t, '<i>' + message(1, '先到'));
  const open = fs.open; let opens = 0;
  t.mock.method(fs, 'open', async (file, ...args) => { if (file === source.xml) opens++; return open(file, ...args); });
  await ingestor.tick(); advance(6000); await ingestor.tick();
  assert.equal(ingestor.xmlStates.get(source.id).complete, false);
  await fs.appendFile(source.xml, message(2, '迟到') + '</i>');
  advance(7000); await ingestor.tick();
  assert.equal(opens, 2);
  advance(36000); await ingestor.tick();
  assert.deepEqual(store.messages(session.id).map(m => m.text), ['先到', '迟到']);
  advance(70000); await ingestor.tick();
  assert.equal(opens, 3);
  assert.equal(ingestor.xmlStates.get(source.id).complete, true);
});

test('录制结束后才出现的 XML 不会因早先文件不存在而永久遗漏', async t => {
  const { store, session, source, ingestor, advance } = await setup(t);
  await ingestor.tick(); advance(6000); await ingestor.tick();
  assert.equal(ingestor.xmlStates.get(source.id).complete, false);
  await fs.writeFile(source.xml, '<i>' + message(3, '稍晚生成的弹幕文件') + '</i>');
  advance(36000); await ingestor.tick();
  assert.equal(store.messages(session.id)[0].text, '稍晚生成的弹幕文件');
  assert.equal(ingestor.xmlStates.get(source.id).complete, true);
});

test('超过单次 4 MiB 的历史 XML 继续快速排空，不能提前按完成封存', async t => {
  const filler = `<gift ts="1">${'x'.repeat(24000)}</gift>`;
  const xml = '<i>' + message(1, '开始') + filler.repeat(190) + message(9, '末尾') + '</i>';
  assert.ok(Buffer.byteLength(xml) > 4 * 1024 * 1024);
  const { store, session, source, ingestor, advance } = await setup(t, xml);
  await ingestor.tick();
  assert.equal(ingestor.xmlStates.get(source.id).complete, false);
  assert.equal(ingestor.xmlStates.get(source.id).nextCheck, 0);
  assert.deepEqual(store.messages(session.id).map(m => m.text), ['开始']);
  advance(6000); await ingestor.tick();
  assert.deepEqual(store.messages(session.id).map(m => m.text), ['开始', '末尾']);
  assert.equal(ingestor.xmlStates.get(source.id).complete, true);
});

test('XML 读取期间素材被删除，不会在删除事务之后重新插入弹幕', async t => {
  const { store, session, source, ingestor } = await setup(t, '<i>' + message(1, '不应复活') + '</i>');
  const open = fs.open; let deletedDuringRead = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === source.xml) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        store.run("UPDATE sessions SET deleted_at='deleted',purge_started_at='deleted' WHERE id=?", session.id);
        store.run('DELETE FROM danmaku WHERE session=?', session.id);
        deletedDuringRead = true;
        return result;
      };
    }
    return handle;
  });
  await ingestor.tick();
  assert.equal(deletedDuringRead, true);
  assert.equal(store.messages(session.id).length, 0);
  assert.equal(store.get('SELECT xmlpos FROM sources WHERE id=?', source.id).xmlpos, 0);
  assert.equal(ingestor.xmlStates.get(source.id).complete, false);
  await ingestor.readDanmaku(source);
  assert.equal(store.messages(session.id).length, 0);
});
