import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {openHlsRecording} from '../server/hls-recording.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const base = 'https://stream.example';
const options = {url:base+'/live.m3u8',ffmpeg,headers:{Cookie:'must-never-send',Authorization:'must-never-send',Referer:'https://www.example/'},
  validateUrl(value) { try { return new URL(value).origin === base ? value : ''; } catch {return '';} },
  validateRedirect(value) { return new URL(value).origin === base ? value : ''; }};

for (const format of ['fmp4','mpegts']) test('records ' + format + ' HLS as playable AVC/AAC FLV', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'caibo-hls-fixture-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12','-f','lavfi','-i','sine=sample_rate=44100',
    '-t','4','-c:v','libx264','-g','12','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-f','hls','-hls_time','1','-hls_playlist_type','vod','-hls_segment_type',format,'index.m3u8'],{cwd:dir});
  const routes = [];
  let manifestLoads = 0;
  const recording = await openHlsRecording({...options,request:async (url, init) => {
    const {pathname,search} = new URL(url);
    routes.push(pathname);
    assert.equal(init.redirect,'manual');
    assert.equal(init.headers.has('Cookie'),false);
    assert.equal(init.headers.has('Authorization'),false);
    if (pathname === '/live.m3u8') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9999,CODECS="hvc1.1.1,mp4a.40.2"\nwrong.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2048,CODECS="avc1.42c0,mp4a.40.2"\nunavailable.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1024,CODECS="avc1.42c0,mp4a.40.2"\nchosen.m3u8?quality=web\n');
    if (pathname === '/unavailable.m3u8') return new Response(null,{status:503});
    if (pathname === '/chosen.m3u8') {
      assert.equal(search,'?quality=web');
      return new Response(null,{status:302,headers:{location:'dir/index.m3u8?signature=example'}});
    }
    assert(pathname.startsWith('/dir/'));
    if (pathname.endsWith('/index.m3u8')) {
      const manifest = (await fs.readFile(path.join(dir,'index.m3u8'),'utf8')).replace('#EXT-X-PLAYLIST-TYPE:VOD','#EXT-X-PLAYLIST-TYPE:EVENT');
      const lines = manifest.split('\n');
      const firstSegment = lines.findIndex(line=>line && !line.startsWith('#'));
      return new Response(++manifestLoads === 1 ? lines.slice(0,firstSegment+1).join('\n') : manifest);
    }
    assert.equal(search,'');
    return new Response(await fs.readFile(path.join(dir,path.basename(pathname))));
  }});
  const out = path.join(dir,'out.flv');
  await fs.writeFile(out, Buffer.from(await new Response(recording.body).arrayBuffer()));
  await recording.closed;
  const metadata=JSON.parse(execFileSync(ffprobe,['-v','error','-show_format','-show_streams','-of','json',out]));
  assert.deepEqual(metadata.streams.map(x=>x.codec_name),['h264','aac']);
  assert(Math.abs(Number(metadata.format.duration)-4)<0.5);
  execFileSync(ffmpeg,['-v','error','-i',out,'-f','null','-']);
  assert(!routes.includes('/wrong.m3u8'));
  assert(routes.includes('/unavailable.m3u8'));
  if (format === 'fmp4') assert.equal(routes.filter(s=>s.endsWith('/init.mp4')).length,1);
});

test('untrusted resources, HTTPS downgrade, encrypted playlists and credentialled redirects fail without following',async()=>{
  for (const reply of [
    new Response('#EXTM3U\n#EXTINF:1,\nold.ts\n#EXT-X-ENDLIST'),
    new Response('#EXTM3U\n#EXT-X-MAP:URI="file:///secret"\n#EXTINF:1,\nx.m4s'),
    new Response('#EXTM3U\n#EXTINF:1,\nhttps://other.example/video.ts'),
    new Response('#EXTM3U\n#EXTINF:1,\nhttp://stream.example/video.ts'),
    new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\nx.ts'),
    new Response(null,{status:302,headers:{location:'https://user:pass@stream.example/live.m3u8'}}),
  ]) {
    let calls = 0;
    await assert.rejects(openHlsRecording({...options,request:async()=>{calls++;return reply;}}),{code:'HLS_SOURCE_ERROR'});
    assert.equal(calls,1);
  }
});

test('cancelling a streaming body stops a stalled child and media request',async()=>{
  const switched = Promise.withResolvers();
  let aborted = false;
  const recording = await openHlsRecording({...options,request:(url, init)=>{
    if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nvideo.ts');
    switched.resolve();
    return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{
      aborted=true;
      reject(init.signal.reason);
    },{once:true}));
  }});
  await switched.promise;
  await recording.body.cancel();
  await recording.closed;
  assert.equal(aborted,true);
});

test('a sliding fMP4 playlist consumes each sequence once, validates ranges and propagates a discontinuity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'caibo-hls-window-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=10','-t','5','-c:v','libx264','-g','10','-threads','1','-f','hls',
    '-hls_time','1','-hls_segment_type','fmp4','-hls_list_size','0','list.m3u8'],{cwd:dir});
  const init = await fs.readFile(path.join(dir,'init.mp4'));
  const segments = await Promise.all(Array.from({length:5},(_,i)=>fs.readFile(path.join(dir,'list'+i+'.m4s'))));
  const media = Buffer.concat(segments);
  const ranges = [];
  let load = 0;
  const recording = await openHlsRecording({...options,request:async (url,options)=>{
    const name = new URL(url).pathname;
    if (name.endsWith('.m3u8')) {
      load++;
      const end = load === 1 ? 1 : load === 2 ? 3 : 4;
      const begin = load === 1 ? 0 : 1;
      let text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:'+begin+'\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init.mp4?token='+load+'"\n';
      for (let i=begin;i<=end;i++) {
        if (i===4) text += '#EXT-X-DISCONTINUITY\n';
        text += '#EXTINF:1,\n#EXT-X-BYTERANGE:'+segments[i].length+'@'+segments.slice(0,i).reduce((n,b)=>n+b.length,0)+'\nall.m4s\n';
      }
      return new Response(text);
    }
    if (name.endsWith('init.mp4')) return new Response(init);
    const range = options.headers.get('Range');
    const [,start,end] = /bytes=(\d+)-(\d+)/.exec(range).map(Number);
    ranges.push(start);
    return new Response(media.subarray(start,end+1),{status:206, headers:{'Content-Range':'bytes '+start+'-'+end+'/'+media.length}});
  }});
  const chunks = [];
  await assert.rejects(async()=>{
    for await (const chunk of recording.body) chunks.push(chunk);
  },{code:'HLS_SOURCE_ERROR',message:/时间轴/});
  await recording.closed;
  assert.deepEqual(ranges,[segments[0].length,segments[0].length+segments[1].length,segments[0].length+segments[1].length+segments[2].length]);
  const file = path.join(dir,'partial.flv');
  await fs.writeFile(file,Buffer.concat(chunks));
  assert.equal(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-count_packets','-show_entries','stream=nb_read_packets','-of','csv=p=0',file]).toString().trim(),'30');
});

test('cancelling after first FLV bytes promptly closes a paused populated stdout', {timeout:7000}, async () => {
  const media=execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=24','-t','3','-c:v','libx264','-preset','ultrafast',
    '-g','24','-threads','2','-f','mpegts','pipe:1'],{maxBuffer:10*1024*1024});
  const recording=await openHlsRecording({...options,request:async url=>url.endsWith('.m3u8')
    ?new Response('#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nlarge.ts') : new Response(media)});
  const reader=recording.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).subarray(0,3).toString(),'FLV');
  await new Promise(resolve=>setTimeout(resolve,100));
  await reader.cancel();
  await recording.closed;
});

test('mislabeled HLS codecs fail before the first FLV byte reaches the recorder', {timeout:10000}, async()=>{
  // Eight 64x48 solid frames (x265, bframes=0, keyint=4, SEI removed).
  // The Windows recorder ships a HEVC demuxer but does not require an encoder.
  const hevc = Buffer.from('AAAAAUABDAH//wFgAAADAJAAAAMAAAMAHpKAkAAAAAFCAQEBYAAAAwCQAAADAAADAB6gIIMWWSrkyvAWgIAAAAMAgAAABQQAAAABRAHBc9CJAAABKAGvEYDohM3/+GncEbeZrAAAAAECAdAJfhDGI/kqkgAAAAECAdAR/9RDBiH5KpIAAAABAgHQGJ/9xDAYhPkqkgAAAAFAAQwB//8BYAAAAwCQAAADAAADAB6SgJAAAAABQgEBAWAAAAMAkAAAAwAAAwAeoCCDFlkq5MrwFoCAAAADAIAAAAUEAAAAAUQBwXPQiQAAASoBrBBNXJjnQ7X//D0v3K1mUYAAAAABAgHQKX4QxiH5KpIAAAABAgHQMf/UQwYj+SqSAAAAAQIB0Dif/cQwGIT5KpI=','base64');
  const media = execFileSync(ffmpeg,['-v','error','-r','10','-f','hevc','-i','pipe:0','-c:v','copy','-bsf:v','setts=pts=N*9000:dts=N*9000',
    '-f','mpegts','pipe:1'],{input:hevc});
  let lists = 0;
  const recording = await openHlsRecording({...options,request:async url=>{
    if (url.endsWith('.m3u8')) {
      const text='#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nmedia.ts\n';
      return new Response(++lists===1 ? text : text+'#EXT-X-ENDLIST');
    }
    return new Response(media);
  }});
  const reader=recording.body.getReader();
  await assert.rejects(reader.read(),{code:'HLS_SOURCE_ERROR'});
  await recording.closed;
});
