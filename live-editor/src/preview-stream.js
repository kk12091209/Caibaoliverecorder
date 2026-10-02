// WebKit's native URL loader probes MP4 with byte ranges. Live FFmpeg output
// has no final byte length, so feed its fragmented MP4 through MediaSource.
const cancelled = () => new DOMException('Preview cancelled', 'AbortError');
function box(bytes, type, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at + 8 <= end;) {
    const size = view.getUint32(at), name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size < 8 || at + size > end) return null;
    if (name === type) return {start: at, payload: at + 8, end: at + size};
    at += size;
  }
  return null;
}
export function previewMime(bytes) {
  const moov = box(bytes, 'moov');
  if (!moov) return null;
  const codecs = [];
  for (let at = moov.payload; at < moov.end;) {
    const trak = box(bytes, 'trak', at, moov.end); if (!trak) break; at = trak.end;
    let entry = trak;
    for (const name of ['mdia', 'minf', 'stbl', 'stsd']) {
      entry = box(bytes, name, entry.payload, entry.end);
      if (!entry) throw new Error('预览视频轨道信息不完整。');
    }
    const video = box(bytes, 'avc1', entry.payload + 8, entry.end);
    if (video) {
      const config = box(bytes, 'avcC', video.payload + 78, video.end);
      if (!config || config.end - config.payload < 4) throw new Error('预览视频编码信息不完整。');
      codecs.push('avc1.' + [...bytes.subarray(config.payload + 1, config.payload + 4)].map(n => n.toString(16).padStart(2, '0')).join(''));
    }
    if (box(bytes, 'mp4a', entry.payload + 8, entry.end)) codecs.push('mp4a.40.2');
  }
  if (!codecs.some(value => value.startsWith('avc1.'))) throw new Error('预览缺少可播放的视频轨道。');
  return `video/mp4; codecs="${codecs.join(',')}"`;
}
function event(target, success, signal, action) {
  return new Promise((resolve, reject) => {
    const clean = () => { target.removeEventListener(success, done); target.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('预览视频解码失败，请重新定位。')); };
    const abort = () => { clean(); reject(cancelled()); };
    target.addEventListener(success, done, {once: true}); target.addEventListener('error', fail, {once: true}); signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) return abort();
    try { action?.(); } catch (error) { clean(); reject(error); }
  });
}
export function previewStream(endpoint, {onError = () => {}, agent = navigator.userAgent, Media = globalThis.MediaSource} = {}) {
  const webkit = /AppleWebKit/.test(agent) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(agent);
  if (!webkit || !Media) return {url: endpoint, dispose() {}, start() {}};
  const source = new Media(), controller = new AbortController(), {signal} = controller;
  const url = URL.createObjectURL(source);
  let started = false;
  return {
    url,
    dispose() { controller.abort(); URL.revokeObjectURL(url); },
    start() {
      if (started) return; started = true;
      void (async () => {
        if (source.readyState !== 'open') await event(source, 'sourceopen', signal);
        const response = await fetch(endpoint, {signal});
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || '预览读取失败，请稍后重试。'); }
        if (!response.body) throw new Error('预览视频流不可用。');
        const reader = response.body.getReader();
        let buffer, initial = new Uint8Array();
        try {
          while (true) {
            const {done, value} = await reader.read(); if (done) break;
            if (!buffer) {
              if (initial.length + value.length > 2 * 1024 * 1024) throw new Error('预览视频头过大。');
              const combined = new Uint8Array(initial.length + value.length); combined.set(initial); combined.set(value, initial.length); initial = combined;
              const mime = previewMime(initial); if (!mime) continue;
              if (!Media.isTypeSupported(mime)) throw new Error('当前播放器不支持此预览编码。');
              buffer = source.addSourceBuffer(mime);
              await event(buffer, 'updateend', signal, () => buffer.appendBuffer(initial)); initial = new Uint8Array();
            } else await event(buffer, 'updateend', signal, () => buffer.appendBuffer(value));
          }
          if (!buffer) throw new Error('所选位置尚未生成画面，请稍后重试。');
          if (!signal.aborted && source.readyState === 'open') source.endOfStream();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      })().catch(error => { if (!signal.aborted) { controller.abort(); onError(error); } });
    }
  };
}
