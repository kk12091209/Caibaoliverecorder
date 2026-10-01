import test from 'node:test';
import { minimalMp4 } from './helpers/mp4-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { isStickerPlaceholder } from '../server/chat-filter.js';
import { Store } from '../server/store.js';
import { DensityService } from '../server/density.js';
import { Media } from '../server/media.js';
import { Ingestor, FLV_HEADER } from '../server/ingest.js';

const placeholders = ['[良辰共此曲动态表情包_谢谢大家]', '[Mygo表情包_忧郁]', '[26mygo的dlc表情包_盯]'];
const retained = ['普通文字', '[笑]', '[doge]', '😂', '这个[Mygo表情包_忧郁]好看', '[Mygo表情包_忧郁]好看',
  '[表情包_忧郁]', '[Mygo表情包_]', '[ 表情包_忧郁]', '[Mygo表情包_ ]',
  '[Mygo表情包_忧[郁]]', '[[Mygo表情包_忧郁]]', '[Mygo表情包_忧郁', '[Mygo表情包_忧郁]]',
  '[Mygo表情包_忧郁]\n', '[Mygo表情包_忧郁]\n[Mygo表情包_盯]', '[Mygo表情包_忧\r郁]',
  '[Mygo表情包_忧郁]\u2028', '[Mygo表情包_' + '长'.repeat(256) + ']', '[Mygo表情包_忧郁]'.repeat(200)];

test('only complete bounded sticker placeholders are hidden; mixed prose, emoji and ambiguous brackets remain', () => {
  for (const text of [...placeholders, placeholders.join(''), ' \t' + placeholders.join(' \t') + '　']) {
    assert.equal(isStickerPlaceholder(text), true, text);
  }
  for (const text of [...retained, '', ' ', null, undefined, 123]) assert.equal(isStickerPlaceholder(text), false, String(text));
});

async function fixture(t, { legacy = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-sticker-test-'));
  const database = path.join(root, 'editor.sqlite');
  if (legacy) {
    // A finished recording created without the new SQL function or filter flags.
    const old = new DatabaseSync(database);
    old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,room INTEGER,created TEXT,status TEXT,
      duration REAL DEFAULT 0,error TEXT DEFAULT '',archive TEXT DEFAULT '',archive_status TEXT DEFAULT 'pending');
      CREATE TABLE danmaku(id TEXT PRIMARY KEY,session TEXT REFERENCES sessions(id),source TEXT,time REAL,user TEXT,text TEXT,type TEXT,color TEXT);
      INSERT INTO sessions(id,title,created,status,duration) VALUES('one','旧素材','2026-09-29T12:00:00+08:00','finished',20);`);
    const insert = old.prepare("INSERT INTO danmaku VALUES(?,'one',NULL,1,'用户',?,'d','16777215')");
    insert.run('old-sticker', placeholders[1]);
    insert.run('old-text', '原有普通弹幕');
    old.close();
  }
  const f = { root, store: new Store(root), density: null, media: null };
  f.store.projectRoot = root;
  if (!legacy) {
    f.store.createSession({ id: 'one', status: 'finished', created: '2026-09-29T12:00:00+08:00' });
    f.store.run("UPDATE sessions SET duration=20 WHERE id='one'");
  }
  let nextId = 0;
  f.add = (text, time = 1, lottery = false) => {
    const id = `new-${++nextId}`;
    f.store.run("INSERT INTO danmaku VALUES(?,'one',NULL,?,'用户',?,'d','16777215')", id, time, text);
    if (lottery) f.store.run("INSERT INTO danmaku_filters VALUES(?,'lottery')", id);
    return id;
  };
  t.after(async () => {
    f.media?.close();
    f.density?.close();
    f.store.close();
    const relative = path.relative(await fs.realpath(os.tmpdir()), await fs.realpath(root));
    assert.ok(relative.startsWith('bili-sticker-test-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return f;
}

async function densityTotal(f) {
  f.density ??= new DensityService(f.store, { batchSize: 17 });
  for (let i = 0; i < 1000; i++) {
    const result = f.density.request('one', { from: 0, to: 20, bins: 20 });
    assert.notEqual(result.status, 'error', result.error);
    if (result.status === 'ready') return result.bins.reduce((sum, value) => sum + value, 0);
    await yieldTurn();
  }
  assert.fail('density did not finish');
}

test('reopening a legacy finished database applies the shared rule immediately without changing raw messages', async t => {
  const f = await fixture(t, { legacy: true });
  const before = f.store.all('SELECT * FROM danmaku ORDER BY id');
  assert.deepEqual(f.store.messages('one').map(message => message.id), ['old-text']);
  assert.equal(await densityTotal(f), 1);
  assert.equal(f.store.get('SELECT count(*) AS n FROM danmaku_filters').n, 0);
  f.density.close();
  f.density = null;
  f.store.close();
  f.store = new Store(f.root);
  assert.deepEqual(f.store.messages('one').map(message => message.id), ['old-text']);
  assert.equal(await densityTotal(f), 1);
  assert.deepEqual(f.store.all('SELECT * FROM danmaku ORDER BY id'), before);
});

test('SQL filters before LIMIT and search, preserving distinct short comments after 650 placeholders', async t => {
  const f = await fixture(t);
  f.store.transaction(() => {
    for (let i = 0; i < 650; i++) f.add(placeholders[i % placeholders.length], 1);
    for (let i = 0; i < 600; i++) f.add('普通弹幕'+i, 2+Math.floor(i/50));
    for (const text of retained.slice(0, 6)) f.add(text, 14);
  });
  const messages = f.store.messages('one', 0, 20, '', 500);
  assert.equal(messages.length, 500);
  assert.ok(messages.every(message => message.text.startsWith('普通弹幕')));
  assert.equal(f.store.messages('one', 0, 20, '', 10000).length, 606);
  assert.deepEqual(f.store.messages('one', 0, 20, 'Mygo', 500).map(message => message.text), retained.slice(4, 6));
  assert.equal(await densityTotal(f), 606);
  assert.equal(f.store.get('SELECT count(*) AS n FROM danmaku').n, 1256);
});

test('fixed lottery and sticker filters preserve incremental chat, manual exclusion and undo', async t => {
  const f = await fixture(t);
  f.add(placeholders[0], 1, true);
  const normal = f.add('普通弹幕', 1);
  f.add('抽奖口令', 1, true);
  assert.equal(await densityTotal(f), 1);
  f.add(placeholders[2], 0.5);
  f.add('迟到普通文字', 0.5);
  assert.equal(await densityTotal(f), 2);
  f.store.saveEdit('one', { ...f.store.edit('one'), filterLottery: false });
  assert.deepEqual(f.store.messages('one').map(message => message.text).sort(), ['普通弹幕', '迟到普通文字'].sort());
  assert.equal(await densityTotal(f), 2);
  f.store.saveEdit('one', { ...f.store.edit('one'), excluded: [normal] });
  assert.equal(await densityTotal(f), 1);
  f.store.saveEdit('one', { ...f.store.edit('one'), excluded: [] });
  assert.equal(await densityTotal(f), 2);
  assert.equal(f.store.get('SELECT count(*) AS n FROM danmaku').n, 5);
});

test('XML ingestion retains placeholders while export ASS and preview/list query omit them consistently', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'source.flv'), xmlFile = path.join(f.root, 'source.xml');
  const texts = [...placeholders, '普通重复', '普通重复', '[doge]', '😂', '这个[Mygo表情包_忧郁]好看'];
  const xml = '<i>' + texts.map((text, index) => `<d p="${index + 1},1,25,16777215,0,0,0,0" user="用户">${text}</d>`).join('') + '</i>';
  await fs.writeFile(file, FLV_HEADER);
  await fs.writeFile(xmlFile, xml);
  const source = f.store.addSource('one', file, 0, '2026-09-29T12:00:00+08:00');
  f.store.run('UPDATE sources SET closed=2,duration=20 WHERE id=?', source.id);
  f.store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, 0, 0, 0);
  await new Ingestor(f.store).readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', source.id));
  assert.equal(f.store.get('SELECT count(*) AS n FROM danmaku').n, texts.length);
  const visible = f.store.messages('one', 0, 20, '', 3000).map(message => message.text);
  assert.deepEqual(visible, texts.slice(3));
  assert.equal(await densityTotal(f), visible.length);
  f.store.saveEdit('one', { ...f.store.edit('one'), ranges: [{ start: 0, end: 12 }], filterLottery: false });
  const media = f.media = new Media(f.store, { exportAcceleration: 'software' });
  media.work = async () => {};
  media.probeSource = async () => ({ width: 640, height: 360, fps: 30 });
  const subtitles = [];
  media.process = async (args, options = {}) => {
    assert.equal(path.dirname(options.cwd), path.join(f.root, 'temp'));
    for (const name of await fs.readdir(options.cwd)) if (name.endsWith('.ass')) subtitles.push(await fs.readFile(path.join(options.cwd, name), 'utf8'));
    for (const argument of args) if (/^(?:part-\d+(?:-danmaku)?|final(?:-danmaku)?)\.mp4$/.test(argument)) await fs.writeFile(path.join(options.cwd, argument), minimalMp4);
  };
  const job = await media.enqueue('one', { mode: 'danmaku', exportDirectory: path.join(f.root, 'exports') });
  const output = await media.exportJob(job);
  assert.deepEqual(await fs.readFile(output), minimalMp4);
  assert.ok(subtitles.length > 0);
  for (const ass of subtitles) {
    const lines = ass.split('\n').filter(line => line.startsWith('Dialogue:'));
    assert.equal(lines.length, visible.length);
    assert.equal(lines.filter(line => line.endsWith('普通重复')).length, 2);
    assert.ok(lines.some(line => line.endsWith('这个[Mygo表情包_忧郁]好看')));
    assert.ok(lines.some(line => line.endsWith('[doge]')));
    assert.ok(lines.every(line => !placeholders.some(text => line.endsWith(text))));
  }
  assert.equal(await fs.readFile(xmlFile, 'utf8'), xml);
  assert.equal(f.store.get('SELECT count(*) AS n FROM danmaku').n, texts.length);
  assert.deepEqual(await fs.readdir(path.dirname(output)), [path.basename(output)]);
});
