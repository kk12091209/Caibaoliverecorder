import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatIntake, CHAT_LIMITS } from '../server/chat-intake.js';

const message = (id, patch = {}) => ({ id: String(id), time: 1, user: '观众', text: '普通重复聊天', ...patch });
function fixture(options = {}) {
  let time = 100000, seed = 17;
  const intake = new ChatIntake({ now: () => time, random: () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;
  }, ...options });
  return { intake, advance: (milliseconds = 1000) => { time += milliseconds; } };
}

test('十个录制房间独立保存每秒 50 条，监控房间不占额度', () => {
  const { intake, advance } = fixture();
  for (let room = 0; room < 10; room++) {
    intake.start('room-' + room);
    for (let n = 0; n < 50; n++) assert.equal(intake.add('room-' + room, message(n)), true);
  }
  assert.equal(intake.add('monitor-only', message('no-recording')), false);
  advance(); let count = 0;
  for (let room = 0; room < 10; room++) { const batch = intake.take('room-' + room); count += batch.messages.length; batch.release(); }
  assert.equal(count, 500); assert.equal(intake.bytes, 0);
});

test('洪峰均匀抽样而不是只保留最初 50 条，其他房间不受影响', () => {
  const { intake, advance } = fixture(); intake.start('busy'); intake.start('quiet');
  for (let n = 0; n < 100000; n++) intake.add('busy', message(n, { time: n / 100000 }));
  for (let n = 0; n < 50; n++) intake.add('quiet', message(n));
  assert.equal(intake.snapshot('busy').pending, 50); advance();
  const busy = intake.take('busy'), quiet = intake.take('quiet');
  assert.equal(busy.messages.length, 50); assert.equal(quiet.messages.length, 50);
  assert.ok(busy.messages.some(item => Number(item.id) > 90000));
  assert.ok(busy.messages.some(item => Number(item.id) < 10000));
  assert.equal(busy.density[0].count, 100000);
  assert.ok(intake.snapshot('busy').recentIds <= CHAT_LIMITS.recentIds);
  busy.release(); quiet.release(); assert.equal(intake.bytes, 0);
});

test('抽奖与表情包在额度前过滤，普通重复文字完整保留', () => {
  const { intake, advance } = fixture({ filterLottery: (_, item) => item.text === '已确认的活动口令' }); intake.start('a');
  for (let n = 0; n < 100000; n++) intake.add('a', message(n, { text: '已确认的活动口令' }));
  intake.add('a', message('sticker', { text: '[小明表情包_感谢大家]' }));
  for (let n = 0; n < 50; n++) assert.equal(intake.add('a', message('ordinary-' + n)), true);
  advance(); const batch = intake.take('a');
  assert.equal(batch.messages.length, 50); assert.equal(batch.density[0].count, 50);
  assert.equal(intake.snapshot('a').filtered, 100001); batch.release();
});

test('只按消息 ID 去重且集合有期限，同文不同 ID 不合并', () => {
  const { intake, advance } = fixture(); intake.start('a');
  assert.equal(intake.add('a', message('1')), true);
  assert.equal(intake.add('a', message('1')), false);
  assert.equal(intake.add('a', message('2')), true);
  advance(); let batch = intake.take('a'); assert.equal(batch.messages.length, 2); batch.release();
  advance(CHAT_LIMITS.recentIdMs);
  assert.equal(intake.add('a', message('1')), true);
  assert.equal(intake.snapshot('a').recentIds, 1);
});

test('单房间条数与字节、全局字节分别限制，写入中的批次也计入预算', () => {
  const { intake, advance } = fixture({ limits: { roomMessages: 3, roomBytes: 1100, totalBytes: 1350 } });
  intake.start('a'); intake.start('b');
  for (let n = 0; n < 3; n++) assert.equal(intake.add('a', message(n, { text: '长'.repeat(29) })), true);
  assert.equal(intake.add('a', message('full')), false);
  assert.equal(intake.add('b', message('global', { text: '长'.repeat(29) })), false);
  advance(); const batch = intake.take('a');
  assert.equal(intake.snapshot('a').pending, 3);
  assert.equal(intake.add('a', message('still-full')), false);
  batch.release(); batch.release(); assert.equal(intake.bytes, 0);
  assert.equal(intake.add('a', message('resumed')), true);
});

test('单房间洪峰无法耗尽其他房间的预算；超大消息不保留', () => {
  const { intake, advance } = fixture({ limits: { roomBytes: 1000, totalBytes: 4000 } }); intake.start('busy'); intake.start('quiet');
  for (let n = 0; n < 1000; n++) intake.add('busy', message(n, { text: '长'.repeat(29) }));
  assert.equal(intake.add('quiet', message('ok')), true);
  assert.equal(intake.add('quiet', message('huge', { text: '长'.repeat(20000) })), false);
  assert.ok(intake.snapshot('busy').bytes <= 1000); advance();
  intake.take('busy').release(); intake.take('quiet').release(); assert.equal(intake.bytes, 0);
});

test('停止后排空末秒，丢弃队列与写入中的批次清理不会重复扣预算', () => {
  const { intake } = fixture(); intake.start('a'); intake.add('a', message('1'));
  assert.equal(intake.take('a'), null); intake.stop('a'); assert.equal(intake.add('a', message('2')), false);
  const batch = intake.take('a', { force: true }); assert.equal(batch.messages.length, 1);
  intake.drop('a'); assert.ok(intake.bytes > 0); batch.release(); assert.equal(intake.bytes, 0); assert.equal(intake.snapshot('a'), null);
});

test('可配置 20 条每秒，超过 50 和无效值拒绝', () => {
  const { intake, advance } = fixture({ limits: { perRoomPerSecond: 20 } }); intake.start('a');
  for (let n = 0; n < 1000; n++) intake.add('a', message(n)); advance();
  const batch = intake.take('a'); assert.equal(batch.messages.length, 20); batch.release();
  assert.throws(() => new ChatIntake({ limits: { perRoomPerSecond: 100 } }), /1～50/);
  assert.throws(() => new ChatIntake({ limits: { roomBytes: 0 } }), /限制无效/);
});
