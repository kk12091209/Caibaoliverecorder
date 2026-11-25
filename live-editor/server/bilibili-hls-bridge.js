import {timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {body, json} from './http-response.js';
import {openHlsRecording} from './hls-recording.js';

function biliMediaUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return '';
    return /\.(?:bilivideo\.com|bilivideo\.cn)$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}

function biliPlaylistUrl(raw) {
  const url = biliMediaUrl(raw);
  return url && /\.m3u8$/i.test(new URL(url).pathname) ? url : '';
}

function authorized(req, token) {
  if (!token || req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin) return false;
  const expected = Buffer.from('Bearer ' + token);
  const actual = Buffer.from(req.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// The local core owns the recording file and XML. The response lives for one
// capture, so stopping that core request also releases the playlist reader.
export async function serveBilibiliHls(req, res, {token, ffmpeg, diagnostics, stopping, shutdownSignal, open = openHlsRecording}) {
  if (!authorized(req, token)) return json(res,{error:'无效的录制核心连接。'},403);
  if (req.method !== 'POST') return json(res,{error:'请求方式无效。'},405);
  if (stopping || shutdownSignal.aborted) return json(res,{error:'录制服务正在退出。'},503);

  let input;
  try { input = await body(req, 16 * 1024); }
  catch (error) { return json(res,{error:'直播线路请求格式无效。'},error.status || 400); }
  const url = typeof input?.url === 'string' && biliPlaylistUrl(input.url);
  const roomId = input?.roomId;
  if (!url || !Number.isSafeInteger(roomId) || roomId <= 0) return json(res,{error:'无效的 B 站直播线路。'},400);

  const client = new AbortController();
  const disconnected = () => client.abort();
  res.once('close', disconnected);
  const signal = AbortSignal.any([client.signal, shutdownSignal]);
  let source;
  try {
    if (res.destroyed) return;
    signal.throwIfAborted();
    source = await open({
      url, signal, ffmpeg, request:fetch,
      headers:{'User-Agent':'Mozilla/5.0', Referer:`https://live.bilibili.com/${roomId}`},
      validateUrl:biliPlaylistUrl, validateRedirect:biliMediaUrl, validateResource:biliMediaUrl,
    });
    if (!source.ok || !source.body) throw new Error();
    for await (const chunk of source.body) {
      signal.throwIfAborted();
      if (!chunk.length) continue;
      if (!res.headersSent) {
        res.writeHead(200,{'Content-Type':'video/x-flv','Cache-Control':'no-store'});
        diagnostics?.record('B站录制',`房间 ${roomId}：HLS 线路已返回媒体数据，开始送入录制核心。`);
      }
      if (!res.write(chunk)) await once(res,'drain',{signal});
    }
    if (!res.headersSent) throw new Error();
    res.end();
  } catch {
    if (!signal.aborted) diagnostics?.record('B站录制',`房间 ${roomId}：HLS 线路未能持续提供可录制的画面，将重新检查。`,{level:'警告'});
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else json(res,{error:'B 站 HLS 画面暂时不可用。'},502);
    }
  } finally {
    client.abort();
    res.off('close', disconnected);
    await source?.closed;
  }
}
