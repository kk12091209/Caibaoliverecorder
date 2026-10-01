import test from 'node:test';
import { minimalMp4 } from './helpers/mp4-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { Ingestor, FLV_HEADER } from '../server/ingest.js';
import { Media } from '../server/media.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-lottery-filter-'));
const opened = new Set();
const xml = (text, lottery, time = 1, user = '同一位观众') => `<d p="${time},1,25,16777215,0,0,0,0" user="${user}"${lottery === undefined ? '' : ` lottery="${lottery}"`}>${text}</d>`;
const fingerprint = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const allMessages = (store, id, filter) => store.messages(id, 0, 20, '', 10000, filter);
async function fixture(name, body, { store, closed = 2, start = 0 } = {}) {
  store ??= new Store(path.join(root, name, 'data'));
  opened.add(store);
  store.projectRoot = path.join(root, name);
  const session = store.createSession({ status: 'finished', created: '2026-09-29T12:00:00+08:00' });
  const file = path.join(store.root, 'synthetic.flv');
  await fs.writeFile(file, FLV_HEADER);
  await fs.writeFile(file.replace(/\.flv$/, '.xml'), body);
  const source = store.addSource(session.id, file, start, session.created, false);
  store.run('UPDATE sessions SET duration=20 WHERE id=?', session.id);
  store.run('UPDATE sources SET closed=?,duration=20 WHERE id=?', closed, source.id);
  const ingestor = new Ingestor(store);
  const read = () => ingestor.readDanmaku(store.get('SELECT * FROM sources WHERE id=?', source.id));
  return { store, session, source, file, xmlFile: source.xml, ingestor, read };
}
function save(store, session, patch) {
  return store.saveEdit(session, { ...store.edit(session), ...patch });
}

 test('600 条同文按新规则折叠，可信抽奖仍独立分类且重读不重复', async () => {
  const normal = Array.from({ length: 600 }, (_,i) => xml('恭喜发财',undefined,i/50)).join('');
  const invalid = ['', 'anchor:0', 'anchor:01', 'anchor:-1', 'anchor:1x', 'anchor:123 ', 'other:123', 'red-pocket:0', 'anchor:123456789012345678901'];
  const valid = ['anchor:123', 'red-pocket:456', 'anchor:99999999999999999999'];
  const f = await fixture('whitelist', '<i>' + normal + invalid.map((value, n) => xml('无效标记' + n, value,13)).join('') + valid.map(value => xml('恭喜发财', value,13)).join('') + '<gift ts="1">礼物</gift></i>');
  try {
    const original = await fingerprint(f.xmlFile);
    await f.read();
    const visible = allMessages(f.store, f.session.id);
    assert.equal(visible.length, 2 + invalid.length);
    assert.equal(visible.filter(message => message.text === '恭喜发财').length, 2);
    assert.equal(new Set(visible.map(message => message.id)).size, visible.length);
    assert.equal(allMessages(f.store, f.session.id, false).length, 2 + invalid.length + valid.length);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku_filters').n, 598 + valid.length);
    assert.deepEqual(f.store.all('SELECT DISTINCT reason FROM danmaku_filters ORDER BY reason').map(row => row.reason), ['lottery','repeat']);
    const ids = allMessages(f.store, f.session.id, false).map(message => message.id);
    await f.read();
    f.store.run('UPDATE sources SET xmlpos=0 WHERE id=?', f.source.id);
    await new Ingestor(f.store).readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', f.source.id));
    assert.deepEqual(allMessages(f.store, f.session.id, false).map(message => message.id), ids);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku_filters').n, 598 + valid.length);
    assert.equal(await fingerprint(f.xmlFile), original);
  } finally { f.store.close(); opened.delete(f.store); }
});

test('密度缓存仅在已索引旧消息补充抽奖分类时失效，新批次及重复导入不触发全量重建', async () => {
  const f = await fixture('density-invalidation', '<i>' + xml('普通保留') + xml('抽奖口令', 'anchor:123') + '</i>');
  const invalidations = [];
  f.store.density = { invalidate: session => invalidations.push(session) };
  try {
    await f.read();
    assert.deepEqual(invalidations, []);
    assert.equal(allMessages(f.store, f.session.id).length, 1);
    const tagged = f.store.get('SELECT message FROM danmaku_filters').message;
    // Simulate a legacy index which already has the original message row but
    // has not yet imported its trusted classification from the unchanged XML.
    f.store.run('DELETE FROM danmaku_filters WHERE message=?', tagged);
    f.store.run('UPDATE sources SET xmlpos=0 WHERE id=?', f.source.id);
    await new Ingestor(f.store).readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', f.source.id));
    assert.deepEqual(invalidations, [f.session.id]);
    assert.equal(allMessages(f.store, f.session.id).length, 1);
    assert.equal(allMessages(f.store, f.session.id, false).length, 2);
    f.store.run('UPDATE sources SET xmlpos=0 WHERE id=?', f.source.id);
    await new Ingestor(f.store).readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', f.source.id));
    assert.deepEqual(invalidations, [f.session.id]);
  } finally { f.store.close(); opened.delete(f.store); }
});
test('真实 XML 增量跨未完成标签和重启：只发布完整消息，普通重复及时间偏移保持原样', async () => {
  const first = xml('中文弹幕同文');
  const lottery = xml('中文弹幕同文', 'red-pocket:456', 2);
  const split = lottery.indexOf('>') + 3;
  const firstPart = '<i>' + first + lottery.slice(0, split);
  const f = await fixture('incremental', firstPart, { closed: 0, start: 5 });
  try {
    await f.read();
    assert.equal(allMessages(f.store, f.session.id, false).length, 1);
    assert.equal(f.store.get('SELECT xmlpos FROM sources WHERE id=?', f.source.id).xmlpos, Buffer.byteLength('<i>' + first));
    const remainder = lottery.slice(split) + xml('中文弹幕同文', undefined, 3) + '</i>';
    await fs.appendFile(f.xmlFile, remainder);
    f.store.run('UPDATE sources SET closed=2 WHERE id=?', f.source.id);
    const restarted = new Ingestor(f.store);
    await restarted.readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', f.source.id));
    assert.deepEqual(allMessages(f.store, f.session.id).map(message => message.time), [6, 8]);
    assert.deepEqual(allMessages(f.store, f.session.id, false).map(message => message.time), [6, 7, 8]);
    await restarted.readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?', f.source.id));
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku').n, 3);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku_filters').n, 1);
    assert.equal(await fs.readFile(f.xmlFile, 'utf8'), firstPart + remainder);
  } finally { f.store.close(); opened.delete(f.store); }
});

test('超过 4 MiB 的弹幕积压跨批读取，末尾抽奖标记不会丢失或提前结束索引', async () => {
  const count = 1800, ordinary = xml('中文'.repeat(450));
  const body = '<i>' + xml('首条抽奖', 'anchor:123') + ordinary.repeat(count) + xml('末条抽奖', 'red-pocket:456') + '</i>';
  assert.ok(Buffer.byteLength(body) > 4 * 1024 * 1024);
  const f = await fixture('bounded-read', body);
  try {
    await f.read();
    const firstCount = f.store.get('SELECT COUNT(*) AS n FROM danmaku').n;
    assert.ok(firstCount > 0 && firstCount < count + 2);
    assert.equal(f.ingestor.xmlStates.get(f.source.id).complete, false);
    for (let n = 0; n < 8 && !f.ingestor.xmlStates.get(f.source.id).complete; n++) await f.read();
    assert.equal(f.ingestor.xmlStates.get(f.source.id).complete, true);
    assert.equal(allMessages(f.store, f.session.id).length, 0);
    assert.equal(allMessages(f.store, f.session.id, false).length, 2);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku_filters').n, 2);
    assert.equal(await fs.readFile(f.xmlFile, 'utf8'), body);
  } finally { f.store.close(); opened.delete(f.store); }
});

test('抽奖过滤固定开启，旧客户端提交 false 也无法关闭；排除和撤销独立保留', async () => {
  const f = await fixture('toggle', '<i>' + xml('普通手动排除') + xml('抽奖甲', 'anchor:123') + xml('抽奖乙', 'red-pocket:456') + '</i>');
  try {
    await f.read();
    const raw = allMessages(f.store, f.session.id, false);
    const ordinary = raw.find(message => message.text === '普通手动排除').id;
    const lottery = raw.find(message => message.text === '抽奖甲').id;
    let edit = save(f.store, f.session.id, { excluded: [ordinary, lottery], undo: [lottery], filterLottery: false });
    assert.equal(allMessages(f.store, f.session.id).length, 1);
    edit = f.store.saveEdit(f.session.id, { revision: edit.revision, ranges: [], excluded: edit.excluded, undo: edit.undo });
    assert.equal(edit.filterLottery, true);
    edit = save(f.store, f.session.id, { filterLottery: true });
    assert.equal(allMessages(f.store, f.session.id).length, 1);
    assert.deepEqual(edit.excluded, [ordinary, lottery]);
    assert.deepEqual(edit.undo, [lottery]);
    assert.throws(() => save(f.store, f.session.id, { filterLottery: 'false' }), /抽奖弹幕/);
    assert.deepEqual(f.store.edit(f.session.id), edit);
    save(f.store, f.session.id, { filterLottery: false });
    assert.equal(allMessages(f.store, f.session.id).length, 1);
    const revision=f.store.edit(f.session.id).revision;
    f.store.run('UPDATE edits SET data=? WHERE session=?',JSON.stringify({ranges:edit.ranges,excluded:edit.excluded,undo:edit.undo,filterLottery:false}),f.session.id);
    assert.equal(f.store.edit(f.session.id).filterLottery,true,'old saved false values read as enabled without rewriting the database');
    assert.equal(f.store.edit(f.session.id).revision,revision);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku').n, 3);
  } finally { f.store.close(); opened.delete(f.store); }
});

async function fakeMedia(f) {
  const media = new Media(f.store, { exportAcceleration: 'software' });
  media.work = async () => {};
  media.probeSource = async () => ({ width: 640, height: 360, fps: 30 });
  f.store.run('INSERT INTO keyframes VALUES(?,?,?,?)', f.source.id, 0, 0, 0);
  const subtitles = [], directories = new Set();
  media.process = async (args, options = {}) => {
    assert.ok(options.cwd && path.dirname(options.cwd) === path.join(f.store.root, 'temp'));
    directories.add(options.cwd);
    for (const name of await fs.readdir(options.cwd)) if (name.endsWith('.ass')) subtitles.push(await fs.readFile(path.join(options.cwd, name), 'utf8'));
    // No encoder is launched: these tiny stand-ins only exercise export selection,
    // ASS generation, snapshot persistence and the publication/cleanup contract.
    for (const argument of args) if (/^(?:part-\d+(?:-danmaku)?|final(?:-danmaku)?)\.mp4$/.test(argument)) await fs.writeFile(path.join(options.cwd, argument), minimalMp4);
  };
  return { media, subtitles, directories };
}

test('片段和整场导出固定使用排队时的过滤/手动排除快照，后续编辑不改变 ASS', async () => {
  const f = await fixture('export-snapshot', '<i>' + xml('普通保留') + xml('普通手动排除') + xml('抽奖甲', 'anchor:123') + xml('抽奖乙', 'red-pocket:456') + '</i>');
  const traced = await fakeMedia(f), { media, subtitles } = traced;
  try {
    await f.read();
    const hash = await fingerprint(f.xmlFile), raw = allMessages(f.store, f.session.id, false);
    const ordinary = raw.find(message => message.text === '普通手动排除').id;
    const lottery = raw.find(message => message.text === '抽奖甲').id;
    save(f.store, f.session.id, { ranges: [{ start: 0, end: 3 }], excluded: [ordinary], filterLottery: true });
    const filtered = await media.enqueue(f.session.id, { mode: 'danmaku' });
    assert.equal(filtered.filterLottery, true);
    save(f.store, f.session.id, { excluded: [], filterLottery: false });
    const first = await media.exportJob(filtered);
    const filteredAss = subtitles.splice(0).join('\n');
    assert.match(filteredAss, /普通保留/);
    assert.doesNotMatch(filteredAss, /普通手动排除|抽奖甲|抽奖乙/);
    assert.equal(JSON.parse(f.store.get('SELECT data FROM jobs WHERE id=?', filtered.id).data).filterLottery, true);
    assert.deepEqual(await fs.readFile(first), minimalMp4);

    save(f.store, f.session.id, { excluded: [ordinary, lottery], filterLottery: false });
    const restored = await media.enqueue(f.session.id, { scope: 'full', mode: 'dual' });
    assert.equal(restored.filterLottery, true);
    assert.deepEqual(restored.excluded, [ordinary, lottery]);
    save(f.store, f.session.id, { excluded: [], filterLottery: true });
    await media.exportJob(restored);
    const restoredAss = subtitles.splice(0).join('\n');
    assert.match(restoredAss, /普通保留/);
    assert.doesNotMatch(restoredAss, /普通手动排除|抽奖甲|抽奖乙/);
    const persisted = JSON.parse(f.store.get('SELECT data FROM jobs WHERE id=?', restored.id).data);
    assert.equal(persisted.filterLottery, true);
    assert.deepEqual(persisted.excluded, [ordinary, lottery]);
    assert.equal(await fingerprint(f.xmlFile), hash);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku').n, 4);
    for (const dir of traced.directories) await assert.rejects(fs.access(dir), /ENOENT/);
  } finally { media.close(); f.store.close(); opened.delete(f.store); }
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('HTTP 列表和叠加始终过滤抽奖，raw 参数和旧编辑开关都不能关闭', async () => {
  // Imported inside the test so store/ingest/export regressions can also run
  // independently while unrelated endpoint modules are being developed.
  const { createApp } = await import('../server/index.js');
  const appRoot = path.join(root, 'http');
  const app = await createApp({automaticClean:false,preparation:false, port: await availablePort(), data: path.join(appRoot, 'data'), projectRoot: appRoot, noRecorder: true, compact: false, ffmpeg: 'not-launched', ffprobe: 'not-launched' });
  app.ingestor.stop();
  try {
    const f = await fixture('http', '<i>' + xml('普通保留') + xml('抽奖口令', 'anchor:123') + xml('抽奖口令', 'red-pocket:456') + '</i>', { store: app.store });
    await f.read();
    const endpoint = `http://127.0.0.1:${app.port}/api/sessions/${f.session.id}`;
    const request = async (route, body) => {
      const response = await fetch(endpoint + route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { response, body: await response.json() };
    };
    for (const query of ['', '?overlay=1', '?raw=1&filterLottery=false', '?q=抽奖']) {
      const result = await request('/messages' + query);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.length, query.includes('q=') ? 0 : 1);
    }
    const excluded = app.store.messages(f.session.id)[0].id;
    const disabled = await request('/edit', { revision: 0, ranges: [], excluded: [excluded], undo: [excluded], filterLottery: false });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.filterLottery, true);
    assert.equal((await request('/messages?overlay=1')).body.length, 1);
    assert.equal((await request('/messages?q=抽奖')).body.length, 0);
    const invalid = await request('/edit', { ...disabled.body, filterLottery: 'false' });
    assert.equal(invalid.response.status, 400);
    assert.equal(app.store.edit(f.session.id).revision, disabled.body.revision);
    const enabled = await request('/edit', { ...disabled.body, filterLottery: true });
    assert.equal(enabled.response.status, 200);
    assert.deepEqual(enabled.body.excluded, [excluded]);
    assert.deepEqual(enabled.body.undo, [excluded]);
    assert.equal((await request('/messages?overlay=1')).body.length, 1);
  } finally { opened.delete(app.store); await app.close(); }
});

test.after(async () => {
  for (const store of opened) try { store.close(); } catch {}
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('bili-lottery-filter-')) await fs.rm(root, { recursive: true, force: true });
});
