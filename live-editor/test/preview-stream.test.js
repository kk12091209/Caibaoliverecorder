import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {previewMime,previewStream} from '../src/preview-stream.js';

for(const audio of [false,true])test(`WebKit previews read actual FFmpeg codec headers, audio=${audio}`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-preview-header-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'preview.mp4');
  execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=30',...(audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),'-t','1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',...(audio?['-c:a','aac']:[]),'-movflags','frag_keyframe+empty_moov+default_base_moof',file]);
  const bytes=new Uint8Array(await fs.readFile(file)),mime=previewMime(bytes);
  assert.match(mime,/^video\/mp4; codecs="avc1\.[0-9a-f]{6}/);
  assert.equal(mime.includes('mp4a.40.2'),audio);
  // Streaming headers may be split anywhere across network chunks.
  let first=8;while(first<bytes.length&&!previewMime(bytes.subarray(0,first)))first++;
  assert.ok(first<bytes.length);assert.equal(previewMime(bytes.subarray(0,first-1)),null);assert.equal(previewMime(bytes.subarray(0,first)),mime);
});

test('Windows WebView2 keeps its existing direct streaming playback',()=>{
  const endpoint='/api/sessions/example/preview?start=1';
  const transport=previewStream(endpoint,{agent:'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Edg/130.0.0.0',Media:class{constructor(){assert.fail('Windows must not use the WebKit workaround');}}});
  assert.equal(transport.url,endpoint);transport.start();transport.dispose();
});

test('seeking away before sourceopen aborts without fetching a stale preview',async t=>{
  let media,requests=0,revoked=0;
  class FakeMedia extends EventTarget {constructor(){super();this.readyState='closed';media=this;}}
  t.mock.method(URL,'createObjectURL',()=> 'blob:qa');t.mock.method(URL,'revokeObjectURL',()=>{revoked++;});
  t.mock.method(globalThis,'fetch',()=>{requests++;assert.fail('cancelled preview must not request data');});
  const transport=previewStream('/preview',{agent:'AppleWebKit/605.1.15 Safari/605.1.15',Media:FakeMedia,onError:()=>assert.fail('intentional cancellation is not a playback failure')});
  transport.start();transport.dispose();media.dispatchEvent(new Event('sourceopen'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(requests,0);assert.equal(revoked,1);
});
