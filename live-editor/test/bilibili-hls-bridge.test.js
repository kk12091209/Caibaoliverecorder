import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {listenLocal} from '../server/local-endpoint.js';
import {serveBilibiliHls} from '../server/bilibili-hls-bridge.js';

const valid = {roomId:3044248,url:'https://cdn.bilivideo.com/live/index.m3u8?sign=test-private'};
const video = Buffer.from('464c5601050000000900000000','hex');

async function fixture(t, open) {
  const token = 'test-recorder-token';
  const shutdown = new AbortController();
  const logs = [];
  const options = {token,ffmpeg:'/bundled/ffmpeg',open,shutdownSignal:shutdown.signal,diagnostics:{record(...args){logs.push(args);}}};
  const server = http.createServer((req,res) => { void serveBilibiliHls(req,res,options); });
  const port = await listenLocal(server);
  t.after(async () => {
    shutdown.abort();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const post = (data, custom = {}) => fetch(`http://127.0.0.1:${port}/internal/recorder-hls`,{
    method:'POST',headers:{authorization:'Bearer ' + token,'content-type':'application/json',...custom},
    body:JSON.stringify(data),
  });
  return {post,shutdown,logs,options};
}

test('Bilibili HLS bridge checks local core authorization, shutdown and playlist ownership before opening media',async t => {
  let calls = 0;
  const f = await fixture(t,async () => { calls++; throw new Error('unexpected open'); });
  for (const headers of [{authorization:''},{authorization:'Basic bad'},{origin:'http://127.0.0.1'}]) {
    assert.equal((await f.post(valid,headers)).status,403);
  }
  for (const url of ['http://cdn.bilivideo.com/live.m3u8','https://bilivideo.com.evil.test/live.m3u8',
    'https://127.0.0.1/live.m3u8','https://test@cdn.bilivideo.com/live.m3u8','https://cdn.bilivideo.cn/movie.flv']) {
    assert.equal((await f.post({...valid,url})).status,400);
  }
  assert.equal((await f.post({...valid,roomId:0})).status,400);
  f.options.stopping = true;
  assert.equal((await f.post(valid)).status,503);
  assert.equal(calls,0);
});

test('Bilibili HLS bridge streams normalized bytes and provides the room referer without forwarding secrets',async t => {
  const f = await fixture(t,async options => {
    assert.equal(options.url,valid.url);
    assert.equal(options.ffmpeg,'/bundled/ffmpeg');
    assert.deepEqual(Object.keys(options.headers).sort(),['Referer','User-Agent']);
    assert.equal(options.headers.Referer,'https://live.bilibili.com/3044248');
    assert.equal(options.validateUrl(valid.url),valid.url);
    assert.equal(options.validateResource('https://region.bilivideo.cn/part.m4s'),'https://region.bilivideo.cn/part.m4s');
    for (const validate of [options.validateResource,options.validateRedirect]) {
      assert.equal(validate('https://other.test/media.m4s'),'');
      assert.equal(validate('file:///local/playlist.m3u8'),'');
    }
    return new Response(video);
  });
  const response = await f.post(valid,{cookie:'local-secret'});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'video/x-flv');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),video);
});

test('Bilibili HLS failure before any output returns a fixed error without the signed URL in logs',async t => {
  const f = await fixture(t,async () => new Response(new ReadableStream({
    start(controller){ controller.error(new Error(valid.url)); },
  })));
  const result = await f.post(valid);
  assert.equal(result.status,502);
  const output = JSON.stringify(f.logs) + await result.text();
  assert.match(output,/3044248/);
  assert.doesNotMatch(output,/test-private|bilivideo\.com|test-recorder-token/);
});

test('Bilibili HLS reader closes when the core stops a recording or the backend exits',async t => {
  for (const reason of ['core','backend']) await t.test(reason,{timeout:5000},async t => {
    const closed = Promise.withResolvers();
    const f = await fixture(t,async ({signal}) => ({
      ok:true,closed:closed.promise,
      body:new ReadableStream({
        start(controller) {
          controller.enqueue(video);
          signal.addEventListener('abort',() => {
            controller.error(new Error('test stream stopped'));
            closed.resolve();
          },{once:true});
        },
      }),
    }));
    const response = await f.post(valid);
    if (reason === 'core') await response.body.cancel();
    else f.shutdown.abort();
    await closed.promise;
    assert.equal(f.logs.length,1);
    assert.match(f.logs[0][1],/开始送入录制核心/);
  });
});
