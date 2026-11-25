import { DouyinFlv as FlvNormalizer, DouyinStreamChange as StreamChange } from './douyin-flv.js';
import { openHlsRecording } from './hls-recording.js';

const maxProbeBytes = 12 * 1024 * 1024;
const maxRoutesPerProtocol = 3;

// Keep both transports in each pass. On a failed pass the next poll starts at
// the next group, even if the platform rotates signatures on every lookup.
function routesForPass(metadata, pass) {
  const routes = metadata.streams?.length ? metadata.streams : [metadata.stream];
  const result = [];
  for (const protocol of ['flv', 'hls']) {
    const group = routes.filter(route => route?.url && (route.protocol ?? 'flv') === protocol);
    const count = Math.min(group.length, maxRoutesPerProtocol);
    for (let i = 0; i < count; i++) result.push(group[(pass * maxRoutesPerProtocol + i) % group.length]);
  }
  return result;
}

async function openFlv(url, {request, streamRedirect}, headers, signal) {
  const origin = url;
  for (let i = 0; i <= 5; i++) {
    const response = await request(url, {signal, headers, redirect:'manual'});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      url = next && streamRedirect(new URL(next,url).href, origin);
      if (!url) throw new Error('直播服务器跳转地址无效。');
      continue;
    }
    if (response.ok && response.body) return response;
    await response.body?.cancel();
    throw new Error(`直播线路暂时不可用（HTTP ${response.status}）。`);
  }
  throw new Error('直播服务器跳转次数过多。');
}

// Validate a real video packet before creating files, starting chat or
// announcing a recording. Keep the accepted prefix for the original writer.
export async function openRecordingInput(metadata, recorder, parentSignal, pass = 0) {
  const headers = {'User-Agent':recorder.userAgent, Referer:recorder.referer};
  for (const candidate of routesForPass(metadata, pass)) {
    parentSignal.throwIfAborted();
    const url = recorder.streamUrl(candidate.url);
    if (!url) continue;
    const isHls = candidate.protocol === 'hls';
    const lifetime = new AbortController();
    const signal = AbortSignal.any([parentSignal,lifetime.signal]);
    const timer = setTimeout(() => lifetime.abort(), isHls ? 25000 : 10000);
    let response, reader;
    const cancelRead = () => { reader?.cancel().catch(() => {}); };
    const close = async () => {
      signal.removeEventListener('abort', cancelRead);
      lifetime.abort();
      try { await reader?.cancel(); } catch {}
      reader?.releaseLock();
      await response?.closed;
    };
    try {
      response = isHls
        ? await openHlsRecording({url, headers, signal, request:recorder.request, ffmpeg:recorder.ffmpeg,
          validateUrl:recorder.streamUrl, validateRedirect:recorder.streamRedirect, validateResource:recorder.streamResource})
        : await openFlv(url, recorder, headers, signal);
      reader = response.body.getReader();
      signal.addEventListener('abort', cancelRead, {once:true});
      signal.throwIfAborted();
      const normalizer = new FlvNormalizer();
      let prefix = [], prefixChange, probed = 0;
      while (normalizer.videoTime === null) {
        const {done, value} = await reader.read();
        signal.throwIfAborted();
        if (done || (probed += value.length) > maxProbeBytes) throw new Error('线路未提供有效画面。');
        let frames;
        try { frames = normalizer.feed(value); }
        catch (e) {
          if (e.code !== 'DOUYIN_STREAM_CHANGE' || normalizer.videoTime === null) throw e;
          frames = e.frames; prefixChange = e;
        }
        for (const frame of frames) prefix.push(frame);
      }
      async function* frames() {
        yield prefix;
        prefix = [];
        if (prefixChange) throw prefixChange;
        while (true) {
          let chunk;
          try { chunk = await reader.read(); }
          catch { throw new StreamChange('直播线路中断，重新获取可用画面。'); }
          if (chunk.done) break;
          let output;
          try { output = normalizer.feed(chunk.value); }
          catch (e) {
            if (e.code === 'DOUYIN_STREAM_CHANGE') { if (e.frames.length) yield e.frames; throw e; }
            throw new StreamChange('直播数据格式发生变化，重新获取兼容线路。');
          }
          yield output;
        }
        normalizer.finish();
      }
      return {candidate, normalizer, frames:frames(), close};
    } catch {
      await close();
      parentSignal.throwIfAborted();
    } finally { clearTimeout(timer); }
  }
  throw Object.assign(new Error('已开播，当前线路未返回兼容画面，稍后重试。'), {code:'RECORDING_INPUT_UNAVAILABLE'});
}
