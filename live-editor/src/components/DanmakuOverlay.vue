<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { layoutDanmaku, commentX, DanmakuTimeline, DANMAKU_FONT_SIZE } from '../danmaku-layout.js';
import { DanmakuClock, DanmakuCache } from '../danmaku-clock.js';
import { danmakuGeometry, danmakuDuration, normalizedDanmakuStyle } from '../../shared/danmaku-style.js';

const props = defineProps({ video: Object, base: { type: Number, default: 0 }, messages: { type: Array, default: () => [] }, excluded: Object, enabled: Boolean, loading: Boolean, font: Object, style: Object });
const canvas = ref(null);
let font = `500 ${DANMAKU_FONT_SIZE}px "Microsoft YaHei", "Segoe UI", sans-serif`;
const clock = new DanmakuClock(), timeline = new DanmakuTimeline();
const measured = new DanmakuCache(2048), sprites = new DanmakuCache(20 * 1024 * 1024);
const metricsEnabled = new URLSearchParams(location.search).get('qaMetrics') === '1';
let context, observer, raf = 0, videoFrame = 0, width = 0, height = 0, scale = 1;
let layout = new Map(), boundVideo, motionPreference, buffering = false, disposed = false;
let geometry=danmakuGeometry(720,props.style);
let lastPaint = 0, lastMediaTime = 0, nextFrameAt = 0;
let stats = { frames: 0, drawMs: 0, maxDrawMs: 0, rasterMisses: 0, measuredMisses: 0, active: 0, lateFrames: 0, minClockStep: Infinity, maxClockStep: 0, since: performance.now() };
const events = ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'loadedmetadata', 'loadeddata', 'resize', 'ratechange', 'ended', 'emptied', 'timeupdate'];

function rebuild(reset = false) {
  if (!context) return;
  context.font = font;
  layout = layoutDanmaku(props.messages, {
    width, height, fontSize:geometry.size,lineHeight:geometry.lineHeight,top:geometry.top,maxLanes:geometry.lanes,exportLayout:true,font:props.font,duration:danmakuDuration(props.style),previous: reset ? new Map() : layout,
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
  const cssWidth = Math.ceil(comment.paintWidth??comment.textWidth) + 8, cssHeight = Math.ceil(geometry.size*1.8)+8;
  bitmap.width = Math.ceil(cssWidth * scale); bitmap.height = Math.ceil(cssHeight * scale);
  const brush = bitmap.getContext('2d');
  brush.setTransform(scale, 0, 0, scale, 0, 0);
  brush.font = font; brush.textBaseline = 'top'; brush.lineJoin = 'round'; brush.lineWidth = 3;
  brush.strokeStyle = '#111111'; brush.fillStyle = color;
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
  lastPaint = 0; lastMediaTime = 0; nextFrameAt = 0;
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
    stats.lateFrames += interval > 1500 / normalizedDanmakuStyle(props.style).fps ? 1 : 0;
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
  const moving = isMoving(), interval = 1000 / normalizedDanmakuStyle(props.style).fps;
  if(moving && now < nextFrameAt - 1){raf = requestAnimationFrame(paint);return;}
  nextFrameAt = moving ? now + interval - (nextFrameAt ? Math.max(0, now - nextFrameAt) % interval : 0) : 0;
  const started = metricsEnabled ? performance.now() : 0;
  context.clearRect(0, 0, width, height);
  const player = boundVideo;
  if (!props.enabled || props.loading || !player || player.readyState < 2 || document.hidden) return;
  if (clock.running !== moving) resetClock();
  if (moving && !player.requestVideoFrameCallback) clock.sample(player.currentTime, now);
  const time = props.base + (moving ? clock.at(now) : player.currentTime);
  context.save();context.beginPath();context.rect(0,0,width,height);context.clip();context.globalAlpha=geometry.opacity;
  let active = 0;
  for (const comment of timeline.at(time)) {
    if (props.excluded?.has(comment.id) || (motionPreference?.matches && time - comment.time > 4)) continue;
    const x = motionPreference?.matches ? 20 : commentX(comment, time, width);
    const sprite = spriteFor(comment);
    context.drawImage(sprite.bitmap, x - 4, comment.y - 4, sprite.width, sprite.height);
    active++;
  }
  context.restore();
  reportMetrics(now, started, time, active);
  if (moving) { queueVideoFrame(); raf = requestAnimationFrame(paint); }
}

function requestPaint() { if (!disposed && !raf) raf = requestAnimationFrame(paint); }
function playbackEvent(event) {
  if(['loadedmetadata','loadeddata','resize'].includes(event.type))resize();
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
  resize();resetClock(); requestPaint(); queueVideoFrame();
}
function resize() {
  if(!canvas.value||!context)return;
  const box = canvas.value.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  if(!box.width||!box.height)return;
  const frameWidth=boundVideo?.videoWidth||1280,frameHeight=boundVideo?.videoHeight||720;
  const fit=Math.min(box.width/frameWidth,box.height/frameHeight),newScale=fit*dpr;
  if(width===frameWidth&&height===frameHeight&&scale===newScale&&canvas.value.width===Math.round(box.width*dpr)&&canvas.value.height===Math.round(box.height*dpr))return;
  if (scale !== newScale) sprites.clear();
  width=frameWidth;height=frameHeight;scale=newScale;
  canvas.value.width=Math.round(box.width*dpr);canvas.value.height=Math.round(box.height*dpr);
  context.setTransform(scale,0,0,scale,(box.width-width*fit)/2*dpr,(box.height-height*fit)/2*dpr);
  updateStyle();
}
let fontGeneration=0,customFace;
function updateStyle(){
  geometry=danmakuGeometry(height||720,props.style);
  font=`${props.font?.italic?'italic ':''}${props.font?.bold?'700':'400'} ${geometry.size}px ${customFace?'"'+customFace.family+'", ':''}"Microsoft YaHei", "Segoe UI", sans-serif`;
  measured.clear();sprites.clear();rebuild(true);
}
async function changeFont(value){
  const generation=++fontGeneration;let face;
  try{if(value?.id){face=new FontFace('Caibo_'+value.id,`url("${value.url}")`);await face.load();}}
  catch{if(generation!==fontGeneration||disposed)return;canvas.value?.dispatchEvent(new CustomEvent('font-error',{bubbles:true}));return;}
  if(disposed||generation!==fontGeneration)return;
  if(customFace)document.fonts.delete(customFace);customFace=face;
  if(face)document.fonts.add(face);
  updateStyle();
}
watch(() => props.font?.id,()=>changeFont(props.font),{immediate:true});
watch([()=>props.style?.size,()=>props.style?.opacity,()=>props.style?.speed,()=>props.font?.advanceRatio],updateStyle);
watch(() => props.style?.fps, () => {resetClock();requestPaint();});
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
  disposed = true; fontGeneration++;if(customFace)document.fonts.delete(customFace);bind(null); cancelAnimationFrame(raf); observer?.disconnect(); sprites.clear(); measured.clear();
  document.removeEventListener('visibilitychange', visibilityChanged); motionPreference?.removeEventListener('change', requestPaint);
});
</script>

<template><canvas ref="canvas" class="danmaku-canvas" aria-hidden="true" /></template>
<style scoped>.danmaku-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;contain:strict}</style>
