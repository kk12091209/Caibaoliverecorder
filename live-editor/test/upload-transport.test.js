import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PublicationBandwidth, MiB } from '../server/publication-bandwidth.js';

test('bundled uploader resumes the same open part, retaining acknowledged chunks', async t => {
  const temporary=mkdtempSync(path.join(os.tmpdir(),'caibo-upload-'));
  t.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const bundle=path.join(temporary,'sdk.cjs'),file=path.join(temporary,'fixture.mp4');
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/build-bilibili-upload-sdk.mjs',import.meta.url)),
    bundle,path.join(temporary,'notices.txt')]);
  const {WebVideoUploader}=createRequire(import.meta.url)(bundle);
  writeFileSync(file,Buffer.alloc(512*1024,42));

  let now=0;
  const governor=new PublicationBandwidth({now:()=>now,delay:async milliseconds=>{
    now+=milliseconds;
    if(now>22_000 && governor.rate===0)governor.update({state:'idle'});
  }});
  const transfer=governor.transfer(),requests=[];
  let responseStatus=200;
  t.mock.method(https,'request',(options,respond)=>{
    const query=new URL(options.path,'https://127.0.0.1').searchParams;
    const record={number:Number(query.get('partNumber')),session:query.get('uploadId'),bytes:0,accepted:false};
    assert.equal(options.rejectUnauthorized,true);
    requests.push(record);
    const stream=new Writable({
      write(data,encoding,finished) {
        record.bytes+=data.length;
        if(requests.length===2 && record.bytes===data.length)governor.update({state:'paused',reason:'录制重连'});
        finished();
      },
      final(finished) {
        assert.equal(record.bytes,Number(options.headers['Content-Length']));
        record.accepted=responseStatus===200;
        const reply=new EventEmitter();reply.statusCode=responseStatus;
        respond(reply);
        reply.emit('end');
        finished();
      }
    });
    return stream;
  });
  const uploader=new WebVideoUploader({path:file,title:'测试'},undefined,{concurrency:1,retryTimes:0,bandwidth:transfer});
  uploader.preupload=async()=>({url:'https://127.0.0.1/upload',biz_id:9,chunk_size:256*1024,auth:'fixture'});
  uploader.getUploadInfo=async()=>({key:'/fixture.mp4',upload_id:'one-session'});
  uploader.mergeVideoApi=async()=>({OK:1});
  assert.equal((await uploader.upload()).cid,9);
  assert.deepEqual(requests.map(r=>[r.number,r.accepted,r.session]),
    [[1,true,'one-session'],[2,false,'one-session'],[2,true,'one-session']]);
  const metrics=transfer.metrics();
  assert.equal(metrics.confirmed,MiB/2);
  assert.ok(metrics.repeated>0 && metrics.repeated===requests[1].bytes);

  responseStatus=503;
  const retry=new WebVideoUploader({path:file,title:'测试'},undefined,{concurrency:1,retryTimes:0,bandwidth:governor.transfer()});
  retry.preupload=uploader.preupload;retry.getUploadInfo=uploader.getUploadInfo;retry.mergeVideoApi=uploader.mergeVideoApi;
  await assert.rejects(retry.upload(),{statusCode:503});
});
