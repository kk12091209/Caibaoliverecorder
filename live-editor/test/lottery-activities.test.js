import test from 'node:test';
import assert from 'node:assert/strict';
import { LotteryActivities } from '../server/lottery-activities.js';
import { ChatIntake } from '../server/chat-intake.js';

const start = 1790856000000;
const activity = (patch = {}) => ({ id: 'fudai:123', start, end: start + 60000, serverNow: start, phrases: ['关注主播，参与福袋'], ...patch });
const message = (patch = {}) => ({ id: 'message', timestamp: start + 1000, time: 1, user: '观众', text: '关注主播，参与福袋', ...patch });

test('活动口令严格按房间和有效区间过滤，同文普通刷屏不推断抽奖', () => {
  const filter = new LotteryActivities({ now: () => start });
  for (let n = 0; n < 100; n++) assert.equal(filter.matches('douyin:1', message()), false);
  assert.equal(filter.update('douyin:1', activity()), true);
  assert.equal(filter.matches('douyin:1', message()), true);
  assert.equal(filter.matches('douyin:2', message()), false);
  assert.equal(filter.matches('douyin:1', message({ text: '我觉得关注主播，参与福袋这个活动很好' })), false);
  assert.equal(filter.matches('douyin:1', message({ timestamp: start - 1 })), false);
  assert.equal(filter.matches('douyin:1', message({ timestamp: start + 60000 })), false);
  assert.equal(filter.matches('douyin:1', message({ timestamp: undefined })), false);
});

test('结束标记阻止迟到的活动重新开启，过期和移除会清理', () => {
  let now = start;
  const filter = new LotteryActivities({ now: () => now });
  filter.update('douyin:1', activity()); filter.update('douyin:1', activity({ closed: true }));
  assert.equal(filter.update('douyin:1', activity()), false);
  assert.equal(filter.matches('douyin:1', message()), false);
  filter.update('douyin:2', activity()); now += 61000;
  assert.equal(filter.matches('douyin:2', message()), false);
  filter.drop('douyin:1'); assert.equal(filter.rooms.has('douyin:1'), false);
});

test('无效、缺少口令和异常超长活动不注册，活动数量有上限', () => {
  const filter = new LotteryActivities({ now: () => start, maxActivities: 2 });
  for (const patch of [{ phrases: [] }, { phrases: [''] }, { phrases: ['a'.repeat(1025)] }, { start: 0 },
    { end: start }, { end: start + 90000000 }, { serverNow: undefined }, { id: '../invalid' }])
    assert.equal(filter.update('douyin:1', activity(patch)), false);
  assert.equal(filter.update('douyin:1', activity({ id: '1' })), true);
  assert.equal(filter.update('douyin:1', activity({ id: '2' })), true);
  assert.equal(filter.update('douyin:1', activity({ id: '3' })), false);
});

test('十万条福袋口令先过滤，普通 50 条不消耗抽奖额度', () => {
  let now = start;
  const filter = new LotteryActivities({ now: () => now }); filter.update('douyin:1', activity());
  const intake = new ChatIntake({ now: () => now, filterLottery: (room, item) => filter.matches(room, item) }); intake.start('douyin:1');
  for (let n = 0; n < 100000; n++) intake.add('douyin:1', message({ id: String(n) }));
  for (let n = 0; n < 50; n++) assert.equal(intake.add('douyin:1', message({ id: 'normal-' + n, text: '哈哈哈' })), true);
  now += 1000; const batch = intake.take('douyin:1');
  assert.equal(batch.messages.length, 50); assert.equal(batch.density[0].count, 50); batch.release();
});
