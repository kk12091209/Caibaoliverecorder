import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayWindow, containsOverlay } from '../src/message-window.js';

test('暂停在直播边缘后，未录到的未来弹幕不会误认为已缓存', () => {
  const cached = overlayWindow('live', 55, 135, 101, false);
  assert.equal(containsOverlay(cached, 'live', 100), false);
  assert.equal(containsOverlay(cached, 'live', 115), false);
  const refreshed = overlayWindow('live', 70, 150, 145, false);
  assert.equal(containsOverlay(refreshed, 'live', 115), true);
  assert.equal(containsOverlay(refreshed, 'live', 135), false);
});

test('已完成素材的已载入窗口可复用，跳出窗口或更换素材重新读取', () => {
  const cached = overlayWindow('done', 55, 135, 500, true);
  assert.equal(containsOverlay(cached, 'done', 120), true);
  assert.equal(containsOverlay(cached, 'done', 130), false);
  assert.equal(containsOverlay(cached, 'done', 50), false);
  assert.equal(containsOverlay(cached, 'other', 100), false);
});
