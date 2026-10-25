import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Run with the package's Node, passing its component/Resources directory.
// Exercise the shipped assets, fonts and FFmpeg rather than synthetic images.
const root=path.resolve(process.argv[2]);
const load=file=>import(pathToFileURL(path.join(root,'live-editor/server',file)));
const {Store}=await load('store.js'),{Media}=await load('media.js'),{DanmakuStylePreview}=await load('danmaku-style-preview.js');
const temporary=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'caibo-packaged-style-'));
const store=new Store(path.join(temporary,'data'));
const executable=name=>path.join(root,'runtime/ffmpeg',name+(process.platform==='win32'?'.exe':''));
const media=new Media(store,{ffmpeg:executable('ffmpeg'),ffprobe:executable('ffprobe')});
try{
  const preview=new DanmakuStylePreview(media);
  for(const motion of [false,true]){
    const result=await preview.render({style:{size:.6,opacity:100,speed:2,fps:30},rate:7,font:null,motion},AbortSignal.timeout(30000));
    assert.ok(result?.bytes.length);assert.equal(result.samples,7);
    assert.equal(result.contentType,motion?'video/mp4':'image/png');
  }
  console.log('PASS packaged static and motion danmaku style previews');
}finally{media.close();await media.waitForSaves();store.close();await fs.rm(temporary,{recursive:true,force:true});}
