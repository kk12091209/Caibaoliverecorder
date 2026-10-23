import { mediaTool } from '../../server/downloader/media/tools.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { growingFile, muxRemoteMp4 } from '../../server/downloader/media/streaming.mjs';

test('growing MP4 transfer follows appended bytes exactly and stops on failure or disconnect',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-tail-test-')),target=path.join(dir,'video.mp4');
  try{
    await writeFile(target,'first');const job={status:'running',stream:{path:target,bytes:5}},controller=new AbortController(),reader=growingFile(job,controller.signal);
    assert.equal((await reader.next()).value.toString(),'first');await appendFile(target,'second');job.stream.bytes=11;
    assert.equal((await reader.next()).value.toString(),'second');job.status='done';assert.equal((await reader.next()).done,true);
    job.status='failed';await assert.rejects(growingFile(job,controller.signal).next(),/取消/);
    job.status='running';const waiting=growingFile(job,controller.signal);await waiting.next();const pending=waiting.next();controller.abort();await assert.rejects(pending,{name:'AbortError'});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('streaming mux emits MP4 before upstream EOF, retains audio and video, and enforces quota',async t=>{
  const ffmpeg=await mediaTool('ffmpeg'),ffprobe=await mediaTool('ffprobe');
  try{execFileSync(ffmpeg,['-version'],{stdio:'ignore'});}catch{t.skip('FFmpeg unavailable');return;}
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-mux-test-'));let release;const gate=new Promise(resolve=>{release=resolve;});
  try{
    execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','24','-map','0:v','-c:v','libx264','-preset','ultrafast','-movflags','+faststart',path.join(dir,'v.mp4'),'-t','24','-map','1:a','-c:a','aac','-movflags','+faststart',path.join(dir,'a.mp4')]);
    const data={video:await readFile(path.join(dir,'v.mp4')),audio:await readFile(path.join(dir,'a.mp4'))};let emitted=false,completeSources=0;
    const openSource=async name=>({status:200,headers:{'content-length':data[name].length,'content-type':'video/mp4'},stream:Readable.from((async function*(){const split=Math.floor(data[name].length*.8);yield data[name].subarray(0,split);await gate;yield data[name].subarray(split);completeSources++;})())});
    const sources={video:['video'],audio:['audio'],referer:'https://www.bilibili.com/'},target=path.join(dir,'out.mp4');
    await muxRemoteMp4(sources,target,{command:ffmpeg,signal:AbortSignal.timeout(5000),maxBytes:20*1024**2,onProgress:()=>()=>{},openSource,onOutput:()=>{if(!emitted){assert.equal(completeSources,0);emitted=true;release();}}});
    assert.equal(emitted,true);assert.equal(completeSources,2);
    const metadata=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type:format=duration','-of','json',target],{encoding:'utf8'}));assert.deepEqual(metadata.streams.map(s=>s.codec_type),['video','audio']);assert.ok(Number(metadata.format.duration)>=24);
    await assert.rejects(muxRemoteMp4(sources,target,{command:ffmpeg,signal:AbortSignal.timeout(5000),maxBytes:5,onProgress:()=>()=>{},onOutput:()=>{},openSource}),/限制/);
  }finally{release();await rm(dir,{recursive:true,force:true});}
});
