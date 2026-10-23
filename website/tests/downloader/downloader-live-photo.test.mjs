import { mediaTool } from '../../server/downloader/media/tools.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { douyinResult, needsGalleryHydration } from '../../server/downloader/platforms/resolver.mjs';
import { douyinScriptItem } from '../../server/downloader/platforms/douyin.mjs';
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs';

const imageURL='https://p11-sign.douyinpic.com/still.jpeg',motionURL='https://v26-web.douyinvod.com/motion.mp4';
const live={width:2160,height:2880,urlList:[imageURL],clipType:5,livePhotoType:1,video:{width:720,height:960,duration:2134,playAddr:[{src:motionURL}]}};
const still={width:1080,height:1440,urlList:[imageURL],video:null,clipType:2,livePhotoType:0};
const item={awemeId:'7699096795486082993',desc:'实况与图片',authorInfo:{nickname:'作者'},images:[live,still,live],video:{duration:60000,playAddr:[{src:'https://sf3-cdn-tos.douyinstatic.com/music.mp3'}]}};

test('mixed galleries retain item order and pair only per-image motion, not the long background music',()=>{
  const result=douyinResult(item);
  assert.equal(result.kind,'images');assert.deepEqual(result.assets.map(a=>a.type),['livePhoto','image','livePhoto']);
  assert.deepEqual(result.assets.map(a=>a.index),[1,2,3]);
  const a=result.assets[0];assert.equal(a.duration,2.134);assert.equal(a.width,2160);assert.equal(a.motionWidth,720);
  assert.deepEqual(a.urls,[motionURL]);assert.deepEqual(a.photoUrls,[imageURL]);assert.equal(result.author,'作者');
  assert.equal(needsGalleryHydration(item),false);
});
test('a single snake-case Live Photo remains a gallery with one MP4 source and no BGM concatenation',()=>{
  const r=douyinResult({aweme_id:'7662598135126167473',images:[{width:2160,height:2880,url_list:[imageURL],live_photo_type:1,clip_type:5,video:{duration:2834,width:720,height:960,play_addr:{url_list:[motionURL]}}}]});
  assert.equal(r.assets.length,1);assert.equal(r.assets[0].type,'livePhoto');assert.equal(r.assets[0].duration,2.834);
});
test('missing motion is not silently converted into a still and incomplete mobile galleries require hydration',()=>{
  assert.throws(()=>douyinResult({...item,images:[{...live,video:null}]}),/未返回动态片段/);
  assert.throws(()=>douyinResult({...item,images:[{...live,video:{playAddr:[{src:'https://aweme.snssdk.com/music.mp3'}]}}]}),/未返回动态片段/);
  assert.equal(needsGalleryHydration({images:[{url_list:[imageURL]}]}),true);
  assert.equal(needsGalleryHydration({video:{}}),false);
  assert.equal(douyinResult({...item,images:[still]}).assets[0].type,'image');
});
test('live motion chooses the highest actual resolution and rejects arbitrary or watermarked hosts',()=>{
  const rates=[{width:1080,height:1440,bitRate:6000,playAddr:[{src:motionURL+'?quality=high'}]},{width:720,height:960,bitRate:9000,playAddr:[{src:motionURL+'?quality=low'}]},{width:4000,height:6000,playAddr:[{src:'https://evil.example/movie.mp4'}]}];
  const r=douyinResult({...item,images:[{...live,video:{...live.video,bitRateList:rates}}]});
  assert.equal(r.assets[0].motionWidth,1080);assert.match(r.assets[0].urls[0],/quality=high/);
});
test('Flight scripts parse split data chunks, ignore recommendations, and never execute script expressions',()=>{
  const payload='7:'+JSON.stringify(['$',null,{other:{...item,awemeId:'99'},aweme:{detail:item}}])+'\n';
  const chunks=[payload.slice(0,80),payload.slice(80)].map(x=>'self.__pace_f.push('+JSON.stringify([1,x])+');');
  assert.equal(douyinScriptItem(chunks,item.awemeId).images[0].video.duration,2134);
  assert.equal(douyinScriptItem(chunks,'999'),null);
  assert.equal(douyinScriptItem(['self.__pace_f.push((()=>{throw Error("must not execute")})())'],item.awemeId),null);
});

test('mixed downloads produce real MP4 per live item and JPG for static items, preserving selection and audio',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-livephoto-test-'));
  const command=promisify(execFile),ffmpeg=await mediaTool('ffmpeg'),ffprobe=await mediaTool('ffprobe');
  let jobs;
  try{
    const source=path.join(dir,'source.mp4');
    await command(ffmpeg,['-v','error','-f','lavfi','-i','color=c=pink:s=96x128:r=15:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',source]);
    const data=await readFile(source),jpg=Buffer.from([255,216,255,217]);
    const images={download:async(_urls,{onProgress})=>{onProgress(jpg.length,jpg.length);return {data:jpg,extension:'jpg',type:'image/jpeg',width:10,height:10}}};
    jobs=new DownloadJobs({}, {images,saveMedia:async(urls,target,{onProgress,signal})=>{assert.deepEqual(urls,[motionURL]);await writeFile(target,data,{signal});onProgress(data.length,data.length)}});
    const session={owner:'test',result:douyinResult(item)},created=jobs.create(session,[3,2,3]),job=jobs.jobs.get(created.id);
    await job.finished;assert.equal(job.status,'done',job.error);
    assert.deepEqual(job.files.map(f=>f.index),[2,3]);assert.deepEqual(job.files.map(f=>f.type),['image/jpeg','video/mp4']);
    assert.match(job.files[1].name,/_003_实况\.mp4$/);assert.equal(job.files[1].hasAudio,true);
    assert.ok(job.files[1].duration<2);assert.equal(job.files[1].width,96);
    const zip=unzipSync(await readFile(job.archive.path));assert.deepEqual(Object.keys(zip),job.files.map(f=>f.name));
    const result=JSON.parse((await command(ffprobe,['-v','error','-show_entries','stream=codec_type:format=format_name','-of','json',job.files[1].path])).stdout);
    assert.ok(result.streams.some(s=>s.codec_type==='audio'));assert.match(result.format.format_name,/mp4/);
    const album=jobs.jobs.get(jobs.create(session,[1],'album').id);await album.finished;
    assert.equal(album.status,'done',album.error);assert.equal(album.archive,undefined);assert.equal(album.files[0].type,'video/mp4');
    assert.throws(()=>jobs.create(session,[1],'livePhoto'),/不支持的保存方式/);
  }finally{await jobs?.close();await rm(dir,{recursive:true,force:true});}
});
