<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { layoutDanmaku, commentX, DanmakuTimeline } from '../danmaku-layout.js';
import { DanmakuClock, DanmakuCache } from '../danmaku-clock.js';

const props = defineProps({ video: Object, base: { type: Number, default: 0 }, messages: { type: Array, default: () => [] }, excluded: Object, enabled: Boolean, loading: Boolean });
const canvas = ref(null);
const font = '500 22px "Microsoft YaHei", "Segoe UI", sans-serif';
const clock = new DanmakuClock(), timeline = new DanmakuTimeline();
const measured = new DanmakuCache(2048), sprites = new DanmakuCache(20 * 1024 * 1024);
const metricsEnabled = new URLSearchParams(location.search).get('qaMetrics') === '1';
let context, observer, raf = 0, videoFrame = 0, width = 0, height = 0, scale = 1;
let layout = new Map(), boundVideo, motionPreference, buffering = false, disposed = false;
let lastPaint = 0, lastMediaTime = 0;
let stats = { frames: 0, drawMs: 0, maxDrawMs: 0, rasterMisses: 0, measuredMisses: 0, active: 0, lateFrames: 0, minClockStep: Infinity, maxClockStep: 0, since: performance.now() };
const events = ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'loadeddata', 'ratechange', 'ended', 'emptied', 'timeupdate'];

function rebuild(reset = false) {
  if (!context) return;
  context.font = font;
  layout = layoutDanmaku(props.messages, {
    width, height, previous: reset ? new Map() : layout,
    measure(text) {
      const existing = measured.get(text);
      if (existing !== undefined) return existing;
      stats.measuredMisses++;
      return measured.set(text, context.measureText(text).width);
    }
  });
  timeline.set(layout); requestPaint();
}

function spriteFor(comment) {
  const color = '#' + ((Number(comment.color) || 16777215) & 0xffffff).toString(16).padStart(6, '0');
  const key = color + ':' + comment.text;
  const cached = sprites.get(key);
  if (cached) return cached;
  const bitmap = document.createElement('canvas');
  const cssWidth = Math.ceil(comment.textWidth) + 8, cssHeight = 40;
  bitmap.width = Math.ceil(cssWidth * scale); bitmap.height = Math.ceil(cssHeight * scale);
  const brush = bitmap.getContext('2d');
  brush.setTransform(scale, 0, 0, scale, 0, 0);
  brush.font = font; brush.textBaseline = 'top'; brush.lineJoin = 'round'; brush.lineWidth = 3;
  brush.strokeStyle = 'rgba(0,0,0,.8)'; brush.fillStyle = color;
  brush.strokeText(comment.text, 4, 4); brush.fillText(comment.text, 4, 4);
  stats.rasterMisses++;
  return sprites.set(key, { bitmap, width: bitmap.width / scale, height: bitmap.height / scale }, bitmap.width * bitmap.height * 4);
}

function isMoving() {
  const player = boundVideo;
  return !!player && props.enabled && !props.loading && !buffering && !document.hidden && !player.paused && !player.ended && !player.seeking && player.readyState >= 2;
}
function resetClock() {
  clock.reset(boundVideo?.currentTime || 0, performance.now(), { running: isMoving(), rate: boundVideo?.playbackRate || 1 });
  lastPaint = 0; lastMediaTime = 0;
}
function queueVideoFrame() {
  const player = boundVideo;
  if (videoFrame || !isMoving() || !player?.requestVideoFrameCallback) return;
  videoFrame = player.requestVideoFrameCallback((now, metadata) => {
    videoFrame = 0;
    if (player !== boundVideo || disposed) return;
    if (isMoving()) clock.sample(metadata.mediaTime, Number.isFinite(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime : now);
    queueVideoFrame();
  });
}
function cancelVideoFrame() {
  if (videoFrame && boundVideo?.cancelVideoFrameCallback) boundVideo.cancelVideoFrameCallback(videoFrame);
  videoFrame = 0;
}
function reportMetrics(now, started, time, active) {
  if (!metricsEnabled) return;
  const draw = performance.now() - started;
  stats.frames++; stats.drawMs += draw; stats.maxDrawMs = Math.max(stats.maxDrawMs, draw); stats.active = active;
  if (lastPaint && clock.running) {
    const step = time - lastMediaTime, interval = now - lastPaint;
    stats.lateFrames += interval > 25 ? 1 : 0;
    stats.minClockStep = Math.min(stats.minClockStep, step); stats.maxClockStep = Math.max(stats.maxClockStep, step);
  }
  lastPaint = now; lastMediaTime = time;
  if (now - stats.since < 1000) return;
  canvas.value.dataset.danmakuMetrics = JSON.stringify({
    frames: stats.frames, averageDrawMs: +(stats.drawMs / stats.frames).toFixed(3), maxDrawMs: +stats.maxDrawMs.toFixed(3),
    active, cachedSprites: sprites.entries.size, spriteMiB: +(sprites.cost / 1024 / 1024).toFixed(2),
    rasterMisses: stats.rasterMisses, measuredMisses: stats.measuredMisses, lateFrames: stats.lateFrames,
    minClockStep: Number.isFinite(stats.minClockStep) ? +stats.minClockStep.toFixed(5) : null, maxClockStep: +stats.maxClockStep.toFixed(5),
    clockSource: boundVideo?.requestVideoFrameCallback ? 'video-frame + RAF' : 'media-time + RAF'
  });
  stats = { frames: 0, drawMs: 0, maxDrawMs: 0, rasterMisses: 0, measuredMisses: 0, active: 0, lateFrames: 0, minClockStep: Infinity, maxClockStep: 0, since: now };
}

function paint(now) {
  raf = 0;
  if (!context || disposed) return;
  const started = metricsEnabled ? performance.now() : 0;
  context.clearRect(0, 0, width, height);
  const player = boundVideo;
  if (!props.enabled || props.loading || !player || player.readyState < 2 || document.hidden) return;
  const moving = isMoving();
  if (clock.running !== moving) resetClock();
  if (moving && !player.requestVideoFrameCallback) clock.sample(player.currentTime, now);
  const time = props.base + (moving ? clock.at(now) : player.currentTime);
  let active = 0;
  for (const comment of timeline.at(time)) {
    if (props.excluded?.has(comment.id) || (motionPreference?.matches && time - comment.time > 4)) continue;
    const x = motionPreference?.matches ? 20 : commentX(comment, time, width);
    const sprite = spriteFor(comment);
    context.drawImage(sprite.bitmap, x - 4, comment.y - 4, sprite.width, sprite.height);
    active++;
  }
  reportMetrics(now, started, time, active);
  if (moving) { queueVideoFrame(); raf = requestAnimationFrame(paint); }
}

function requestPaint() { if (!disposed && !raf) raf = requestAnimationFrame(paint); }
function playbackEvent(event) {
  if (event.type === 'waiting' || event.type === 'seeking' || event.type === 'emptied') buffering = true;
  else if (event.type === 'playing' || event.type === 'seeked' || event.type === 'loadeddata') buffering = false;
  if (event.type !== 'timeupdate') resetClock();
  if (!isMoving()) cancelVideoFrame();
  requestPaint(); queueVideoFrame();
}
function visibilityChanged() { cancelVideoFrame(); resetClock(); requestPaint(); queueVideoFrame(); }
function bind(player) {
  cancelVideoFrame();
  if (boundVideo) for (const event of events) boundVideo.removeEventListener(event, playbackEvent);
  boundVideo = player; buffering = false;
  if (player) for (const event of events) player.addEventListener(event, playbackEvent);
  resetClock(); requestPaint(); queueVideoFrame();
}
function resize() {
  const box = canvas.value.getBoundingClientRect(), newScale = Math.min(devicePixelRatio || 1, 2);
  if (width === box.width && height === box.height && scale === newScale) return;
  if (scale !== newScale) sprites.clear();
  width = box.width; height = box.height; scale = newScale;
  canvas.value.width = Math.round(width * scale); canvas.value.height = Math.round(height * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0); rebuild(true);
}
watch(() => props.video, bind);
watch(() => props.messages, () => rebuild());
watch(() => [props.base, props.enabled, props.loading], () => { cancelVideoFrame(); resetClock(); requestPaint(); queueVideoFrame(); });
watch(() => props.excluded, requestPaint);
onMounted(() => {
  context = canvas.value.getContext('2d', { alpha: true });
  observer = new ResizeObserver(resize); observer.observe(canvas.value);
  motionPreference = matchMedia('(prefers-reduced-motion: reduce)'); motionPreference.addEventListener('change', requestPaint);
  document.addEventListener('visibilitychange', visibilityChanged); bind(props.video); resize();
});
onBeforeUnmount(() => {
  disposed = true; bind(null); cancelAnimationFrame(raf); observer?.disconnect(); sprites.clear(); measured.clear();
  document.removeEventListener('visibilitychange', visibilityChanged); motionPreference?.removeEventListener('change', requestPaint);
});
</script>

<template><canvas ref="canvas" class="danmaku-canvas" aria-hidden="true" /></template>
<style scoped>.danmaku-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;contain:strict}</style>
