import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';

const manifestLimit = 1024 * 1024;
const segmentLimit = 64 * 1024 * 1024;
const error = message => Object.assign(new Error(message), {code: 'HLS_SOURCE_ERROR'});

function httpUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash) return '';
    return url.href;
  } catch { return ''; }
}

// The FFmpeg process only sees bytes on stdin. Every playlist, map, segment
// and redirect is resolved here under the originating platform's CDN policy.
function transport({url, validateUrl, validateRedirect, validateResource, request, headers, signal}) {
  const root = validateUrl(url) && httpUrl(url);
  if (!root) throw error('HLS 直播地址无效。');
  const safeHeaders = new Headers();
  const provided = new Headers(headers);
  for (const key of ['user-agent','referer']) if (provided.has(key)) safeHeaders.set(key, provided.get(key));

  function resolve(value, parent) {
    const candidate = httpUrl(value, parent);
    if (!candidate || new URL(parent).protocol === 'https:' && new URL(candidate).protocol !== 'https:') throw error('HLS 媒体地址无效。');
    if (validateResource) {
      if (validateResource(candidate, parent, root)) return candidate;
    } else if (new URL(candidate).origin === new URL(parent).origin || validateUrl(candidate)) return candidate;
    throw error('HLS 媒体地址不属于直播平台。');
  }
  async function get(url, range) {
    const fetchHeaders = new Headers(safeHeaders);
    if (range) fetchHeaders.set('range', 'bytes=' + range.start + '-' + range.end);
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      const response = await request(current, {headers: fetchHeaders, redirect:'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])});
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location && httpUrl(location, current);
        if (!next || new URL(current).protocol === 'https:' && new URL(next).protocol !== 'https:' || !validateRedirect(next, url)) throw error('HLS 直播服务器跳转地址无效。');
        current = next;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw error('HLS 直播服务器暂时未提供数据（HTTP ' + response.status + '）。');
      }
      if (range && (response.status !== 206 || !matchesRange(response.headers.get('content-range'), range))) {
        await response.body.cancel();
        throw error('HLS 分片返回的字节范围不匹配。');
      }
      return {response, current};
    }
    throw error('HLS 直播地址跳转次数过多。');
  }

  async function playlist(url) {
    const {response,current} = await get(url);
    const parts = [];
    for await (const bytes of boundedBody(response, manifestLimit)) parts.push(bytes);
    return parsePlaylist(Buffer.concat(parts).toString('utf8'), uri => resolve(uri, current));
  }
  async function* media({url,range}, limit = segmentLimit) {
    const {response} = await get(url, range);
    yield* boundedBody(response, limit, range ? range.end-range.start+1 : undefined);
  }
  return {root, playlist, media};
}

function matchesRange(value, range) {
  const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(value || '');
  return match && Number(match[1]) === range.start && Number(match[2]) === range.end;
}

async function* boundedBody(response, limit, expected) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw error('HLS 媒体响应超出读取上限。');
  }
  let count = 0;
  for await (const bytes of response.body) {
    count += bytes.length;
    if (count > limit || expected !== undefined && count > expected) throw error('HLS 媒体响应超出读取上限。');
    yield bytes;
  }
  if (!count || expected !== undefined && count !== expected) throw error('HLS 媒体响应不完整。');
}

function attr(text, name) {
  return new RegExp('(?:^|,)' + name + '=(?:"([^"]*)"|([^,]*))').exec(text)?.slice(1).find(value => value !== undefined);
}

function rangeFor(value, previous, url) {
  if (!value) return null;
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw error('HLS 分片范围无效。');
  let start = Number(match[2]);
  if (match[2] === undefined && previous?.url === url && previous.range) start = previous.range.end+1;
  const length = Number(match?.[1]);
  if (!Number.isSafeInteger(start) || start < 0 || !(length > 0 && length <= segmentLimit) || !Number.isSafeInteger(start + length)) throw error('HLS 分片范围无效。');
  return {start,end:start+length-1};
}

function parsePlaylist(text, resolve) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== '#EXTM3U') throw error('直播线路未返回 HLS 播放列表。');
  let variant, map = null, range = '', sequence = 0, discontinuity = 0, target = 2, ended = false, vod = false, gap = false;
  const segments = [], variants = [], separateAudio = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      if (variant !== undefined) {
        const codecs = attr(variant,'CODECS');
        const compatible = !codecs || codecs.split(',').every(codec => /^(?:avc[13](?:\.|$)|mp4a(?:\.|$))/i.test(codec.trim()));
        if (compatible) variants.push({url:resolve(line), audio:attr(variant,'AUDIO'), bandwidth:Number(attr(variant,'BANDWIDTH')) || 0});
        variant = undefined;
      } else {
        const url = resolve(line);
        const resource = {url, range:rangeFor(range,segments.at(-1),url), sequence: sequence++, discontinuity, map, gap};
        if (!Number.isSafeInteger(sequence)) throw error('HLS 分片序号无效。');
        segments.push(resource);
        range = '';
        gap = false;
      }
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0,colon);
    const value = line.slice(colon+1);
    switch (tag) {
      case '#EXT-X-STREAM-INF': variant = value; break;
      case '#EXT-X-MEDIA':
        if (attr(value,'TYPE') === 'AUDIO' && attr(value,'URI')) separateAudio.add(attr(value,'GROUP-ID'));
        break;
      case '#EXT-X-KEY':
      case '#EXT-X-SESSION-KEY':
        if (attr(value,'METHOD') !== 'NONE') throw error('此 HLS 线路需要解密，正在尝试其他可用线路。');
        break;
      case '#EXT-X-I-FRAMES-ONLY': throw error('HLS 线路只提供关键帧。');
      case '#EXT-X-SKIP': throw error('HLS 线路只提供增量分片列表。');
      case '#EXT-X-MEDIA-SEQUENCE':
        sequence = Number(value);
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw error('HLS 分片序号无效。');
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        discontinuity = Number(value);
        if (!Number.isSafeInteger(discontinuity) || discontinuity < 0) throw error('HLS 分片序号无效。');
        break;
      case '#EXT-X-TARGETDURATION': if (Number(value)>0) target = Number(value); break;
      case '#EXT-X-MAP': {
        const uri = attr(value,'URI');
        if (!uri) throw error('HLS 初始化分片地址缺失。');
        const url = resolve(uri);
        map = {url,range:rangeFor(attr(value,'BYTERANGE'),map,url)};
        break;
      }
      case '#EXT-X-BYTERANGE': range = value; break;
      case '#EXT-X-DISCONTINUITY': discontinuity++; break;
      case '#EXT-X-GAP': gap = true; break;
      case '#EXT-X-PLAYLIST-TYPE': vod = value === 'VOD'; break;
      case '#EXT-X-ENDLIST': ended = true; break;
    }
  }
  if (segments.length && variants.length) throw error('HLS 播放列表类型无效。');
  return {segments,ended,vod,target,variants:variants.filter(item=>!separateAudio.has(item.audio)).sort((a,b)=>b.bandwidth-a.bandwidth)};
}

async function openPlaylist(io, signal) {
  const visited = new Set();
  async function open(url, depth) {
    signal.throwIfAborted();
    if (depth > 3 || visited.size >= 8 || visited.has(url)) throw error('HLS 播放列表嵌套过多或重复。');
    visited.add(url);
    const list = await io.playlist(url);
    if (list.ended || list.vod) throw error('此 HLS 线路已经结束，正在检查其他直播线路。');
    if (list.segments.length) return {list,url};
    let lastError;
    for (const variant of list.variants) {
      if (visited.size >= 8) break;
      try { return await open(variant.url, depth+1); }
      catch (cause) { signal.throwIfAborted(); lastError = safeError(cause); }
    }
    throw lastError || error('HLS 暂无可录制的完整音视频分片。');
  }
  return open(io.root,0);
}

async function* mediaBytes(io, list, url, signal) {
  // A new capture joins at the live edge. A later ENDLIST flushes the tail.
  const first = list.segments.at(-1);
  let next = first.sequence;
  let mapKey = JSON.stringify(first.map);
  let mapHash;
  if (first.map) {
    const hash = createHash('sha256');
    for await (const bytes of io.media(first.map, 4 * 1024 * 1024)) {
      hash.update(bytes);
      yield bytes;
    }
    mapHash = hash.digest('hex');
  }
  let progressed = Date.now();
  while (true) {
    signal.throwIfAborted();
    for (const part of list.segments) {
      if (part.sequence < next) continue;
      if (part.sequence !== next || part.gap || part.discontinuity !== first.discontinuity || !!part.map !== !!first.map)
        throw error('HLS 分片或时间轴发生切换，需要重新连接。');
      // Some CDNs renew the map signature on each playlist reload. Only a
      // change to its contents requires starting a fresh FLV stream.
      if (part.map && JSON.stringify(part.map) !== mapKey) {
        const hash = createHash('sha256');
        for await (const bytes of io.media(part.map, 4 * 1024 * 1024)) hash.update(bytes);
        if (hash.digest('hex') !== mapHash) throw error('HLS 视频初始化信息已变化，需要重新连接。');
        mapKey = JSON.stringify(part.map);
      }
      yield* io.media(part);
      progressed = Date.now();
      next++;
    }
    if (list.ended) return;
    if (Date.now() - progressed > Math.max(15000,Math.min(45000,list.target*4000))) throw error('HLS 播放列表长时间未提供新分片。');
    await delay(Math.max(250, Math.min(5000, list.target*500)), undefined, {signal});
    list = await io.playlist(url);
  }
}

// "closed" includes the remote input pump and child lifetime. Cancelling the
// body or aborting the owning recording interrupts a stalled read as well.
export async function openHlsRecording({url, signal, headers, validateUrl, validateRedirect, validateResource, request=fetch, ffmpeg}) {
  if (!ffmpeg) throw error('HLS 录制需要 FFmpeg 组件。');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const combined = signal ? AbortSignal.any([signal,lifetime.signal]) : lifetime.signal;
  const io = transport({url, signal:combined, request, headers, validateUrl, validateRedirect, validateResource});
  const startupDeadline = setTimeout(() => lifetime.abort(error('HLS 线路长时间未提供可录制的画面。')), 20000);
  startupDeadline.unref?.();
  let start;
  try { start = await openPlaylist(io, combined); }
  catch (cause) {
    clearTimeout(startupDeadline);
    combined.throwIfAborted();
    throw safeError(cause);
  }
  if (combined.aborted) { clearTimeout(startupDeadline); combined.throwIfAborted(); }
  const first = start.list.segments.at(-1);
  const inputFormat = first.map ? 'mov' : 'mpegts';
  const args = ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-f',inputFormat,
    '-analyzeduration','500000','-probesize','512k','-i','pipe:0','-map','0:v:0','-map','0:a:0?',
    // Force FLV's legacy codec IDs. The muxer rejects HEVC/AV1/other audio
    // before writing its header even if the origin advertised an AVC stream.
    '-c','copy','-tag:v','7','-tag:a','10','-bsf:a','aac_adtstoasc','-flvflags','no_duration_filesize','-flush_packets','1','-f','flv','pipe:1'];
  const child = spawn(ffmpeg, args, {windowsHide:true, stdio:['pipe','pipe','ignore']});
  let failure, exited = false;
  const exit = new Promise(resolve => {
    child.once('error', () => { failure ??= error('HLS 录制组件无法启动。'); });
    child.once('close', code => {
      exited = true;
      clearTimeout(startupDeadline);
      if (code !== 0 && !combined.aborted) failure ??= error('HLS 音视频无法转换为当前录像格式。');
      lifetime.abort();
      resolve();
    });
  });
  const stop = () => {
    if (exited) return;
    // A consumer may stop while stdout is paused with unread buffered output.
    // Closing our pipe ends lets ChildProcess emit 'close' on every platform.
    child.stdout.destroy();
    child.stdin.destroy();
    child.kill('SIGKILL');
  };
  combined.addEventListener('abort', stop, {once:true});
  async function* input() {
    try { yield* mediaBytes(io,start.list,start.url,combined); }
    catch (cause) { if (!combined.aborted) failure = safeError(cause); }
  }
  const feeding = pipeline(Readable.from(input()), child.stdin, {signal:combined}).catch(() => {});
  const closed = Promise.all([feeding,exit]).then(() => { combined.removeEventListener('abort', stop); });
  const output = child.stdout[Symbol.asyncIterator]();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const part = await output.next();
        if (!part.done) { clearTimeout(startupDeadline); controller.enqueue(part.value); return; }
        await closed;
        signal?.throwIfAborted();
        if (lifetime.signal.reason?.code === 'HLS_SOURCE_ERROR') throw lifetime.signal.reason;
        if (failure) throw failure;
        controller.close();
      } catch (cause) { lifetime.abort(); controller.error(signal?.aborted ? signal.reason : safeError(cause)); }
    },
    async cancel() { lifetime.abort(); await closed; },
  });
  return {ok:true, status:200, body, closed};
}

function safeError(cause) {
  return cause?.code === 'HLS_SOURCE_ERROR' ? cause : error('HLS 直播数据暂时无法读取。');
}
