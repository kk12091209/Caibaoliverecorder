import test from 'node:test';
import assert from 'node:assert/strict';
import { livePreparationView } from '../src/preparation-state.js';

const session = { id: 'current', status: 'recording' };
const state = (live = {}) => ({ enabled: true, liveEnabled: true, live: { sessionId: 'current', ...live } });

test('录中提示只在总开关和录中开关同时打开时显示，已结束素材保留原有状态', () => {
  assert.equal(livePreparationView(session, {}), null);
  assert.equal(livePreparationView(session, { ...state(), enabled: false }), null);
  assert.equal(livePreparationView(session, { ...state(), liveEnabled: false }), null);
  assert.equal(livePreparationView({ ...session, status: 'finished' }, state()), null);
});

test('录中进度与当前素材匹配，已提前处理的时长在退让时仍显示', () => {
  const entry = { session: 'current', preparedSeconds: 120, totalSeconds: 240 };
  const active = livePreparationView(session, state({ active: true }), entry);
  assert.equal(active.label, '录制中 · 已提前处理 00:02:00');
  assert.equal(active.active, true);
  const waiting = livePreparationView(session, state({ active: false, reason: 'recording-unhealthy' }), entry);
  assert.equal(waiting.label, active.label);
  assert.match(waiting.note, /优先保证录制/);
  assert.equal(waiting.active, false);
  assert.equal(livePreparationView({ ...session, status: 'waiting' }, state({ active: false }), entry).label, '等待重连 · 已提前处理 00:02:00');
});

test('不把其他房间的后台处理显示为当前素材的进度或活动', () => {
  const view = livePreparationView(session, state({ active: true, sessionId: 'other' }), { session: 'other', preparedSeconds: 120 });
  assert.equal(view.label, '优先保证录制，稍后继续处理');
  assert.equal(view.active, false);
});

test('尾部缓冲等待与实际处理区分显示，不泄露调度参数', () => {
  assert.equal(livePreparationView(session, state({ reason: 'tail' })).label, '录制中 · 等待稳定片段');
  assert.equal(livePreparationView(session, state({ active: true })).label, '录制中 · 正在提前处理');
  assert.equal(livePreparationView(session, state({ reason: 'work-budget' })).label, '优先保证录制，稍后继续处理');
});
