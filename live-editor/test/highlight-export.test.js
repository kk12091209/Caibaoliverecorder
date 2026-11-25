import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {HIGHLIGHT_SETTING} from '../shared/highlight-style.js';
import {DanmakuStylePreview} from '../server/danmaku-style-preview.js';
import {saveGift,giftFromXml} from '../server/gifts.js';
import {DEFAULT_DANMAKU_STYLE} from '../shared/danmaku-style.js';
const ffmpeg=process.env.FFMPEG_PATH,ffprobe=process.env.FFPROBE_PATH;
test('real dual export freezes highlighted message and style; enlarged green text appears only in the baked file',async t=>{
 if(!ffmpeg||!ffprobe){t.skip('FFmpeg runtime is unavailable');return;}
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'highlight-export-')),file=path.join(root,'source.flv');
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x101820:size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','9','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-c:a','aac','-f','flv','-y',file]);
 const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished',title:'highlight-test'}),source=store.addSource(session.id,file,0,'2026-10-30T06:00:00Z',true),ingest=new Ingestor(store),media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});
 t.after(async()=>{await media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(source.xml,'<i><d p="1,1,25,16777215,0,0,123,0" user="TESTER">HELLO</d><d p="4,1,25,16777215,0,0,456,0" user="OTHER">HELLO</d></i>');
 for(let i=0;i<15;i++)await ingest.tick();const rows=store.messages(session.id);
 store.saveEdit(session.id,{...store.edit(session.id),highlighted:[rows[0].id]});store.setting(HIGHLIGHT_SETTING,{scale:3,showSender:true,color:'#00FF00'});
 const work=media.work.bind(media);media.work=()=>{};
 const result=await media.enqueue(session.id,{scope:'full',mode:'dual',exportDirectory:path.join(root,'out')}),id=result.id||result.jobs[0].id;
 const submitted=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',id).data);assert.deepEqual(submitted.highlighted,[rows[0].id]);assert.deepEqual(submitted.highlightStyle,{scale:3,showSender:true,color:'#00FF00'});
 store.saveEdit(session.id,{...store.edit(session.id),highlighted:[rows[1].id]});store.setting(HIGHLIGHT_SETTING,{scale:1,showSender:false,color:'#FF0000'});
 media.work=work;await media.work();const job=store.get('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'done',job.error);
 const baked=JSON.parse(job.data).output.danmakuFile;
 const pixels=(name,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',name,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const green=bytes=>{const ys=[];let count=0;for(let i=0;i<bytes.length;i+=3)if(bytes[i+1]>100&&bytes[i+1]>bytes[i]*1.8&&bytes[i+1]>bytes[i+2]*1.8){count++;ys.push(Math.floor(i/3/320));}return {count,height:ys.length?Math.max(...ys)-Math.min(...ys)+1:0};};
 assert.equal(green(pixels(job.file,3)).count,0);assert.equal(green(pixels(baked,.2)).count,0);
 const shown=green(pixels(baked,3));assert.ok(shown.count>300,JSON.stringify(shown));assert.ok(shown.height>20,'3x text is materially taller than the ordinary 13px glyph');
 const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type','-of','json',baked]));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
 if(process.env.CAIBO_HIGHLIGHT_EVIDENCE){await fs.mkdir(process.env.CAIBO_HIGHLIGHT_EVIDENCE,{recursive:true});execFileSync(ffmpeg,['-v','error','-ss','3','-i',baked,'-frames:v','1','-y',path.join(process.env.CAIBO_HIGHLIGHT_EVIDENCE,'highlight-export.png')]);}
});
test('real style preview paints selected highlight samples with custom color and follows scale changes',async t=>{
 if(!ffmpeg||!ffprobe){t.skip('FFmpeg runtime is unavailable');return;}
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'highlight-preview-')),store=new Store(path.join(root,'data')),media=new Media(store,{ffmpeg,ffprobe});t.after(async()=>{await media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
 const assets=path.join(root,'assets');await fs.mkdir(assets);await fs.copyFile(new URL('../src/assets/danmaku-style-preview.webp',import.meta.url),path.join(assets,'danmaku-style-preview-test.webp'));await fs.writeFile(path.join(root,'asset-manifest.json'),JSON.stringify({'src/assets/danmaku-style-preview.webp':{file:'assets/danmaku-style-preview-test.webp'}}));
 const preview=new DanmakuStylePreview(media,{imageRoot:assets}),input={style:DEFAULT_DANMAKU_STYLE,rate:8,font:null,highlighted:['00','02'],highlightStyle:{scale:2,showSender:true,color:'#00FF00'}};
 const large=await preview.render(input,AbortSignal.timeout(20000)),small=await preview.render({...input,highlightStyle:{...input.highlightStyle,scale:1}},AbortSignal.timeout(20000));
 const colors=png=>execFileSync(ffmpeg,['-v','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{input:png,maxBuffer:8*1024*1024});
 const count=bytes=>{let n=0;for(let i=0;i<bytes.length;i+=3)if(bytes[i+1]>150&&bytes[i]<70&&bytes[i+2]<70)n++;return n;};
 assert.ok(count(colors(large.bytes))>count(colors(small.bytes))*1.5,'2x sample size changes actual preview pixels');
 if(process.env.CAIBO_HIGHLIGHT_EVIDENCE)await fs.writeFile(path.join(process.env.CAIBO_HIGHLIGHT_EVIDENCE,'highlight-style-preview.png'),large.bytes);
});

test('export preserves preview-scale glyph height with and without a real gift card', async t => {
  if (!ffmpeg || !ffprobe) { t.skip('FFmpeg runtime is unavailable'); return; }
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'highlight-size-'));
  const width = 640, height = 360, file = path.join(root, 'source.flv');
  execFileSync(ffmpeg, ['-v','error','-f','lavfi','-i','color=c=0x101820:size=640x360:rate=15','-t','7',
    '-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-f','flv','-y',file]);
  const store = new Store(path.join(root, 'data'));
  const media = new Media(store, { ffmpeg, ffprobe, exportAcceleration: 'software' });
  t.after(async () => { await media.close(); store.close(); await fs.rm(root, { recursive:true, force:true }); });

  const session = store.createSession({ status:'finished', title:'highlight-size' });
  const source = store.addSource(session.id, file, 0, '2026-10-30T06:00:00Z', true);
  await fs.writeFile(source.xml,'<i><d p="1,1,25,16777215,0,0,123,0" user="H3x3d">在</d></i>');
  const ingest = new Ingestor(store);
  await ingest.tick();
  store.saveEdit(session.id, { ...store.edit(session.id), highlighted:[store.messages(session.id)[0].id] });
  store.setting(HIGHLIGHT_SETTING, { scale:2.5, showSender:true, color:'#00FF00' });
  saveGift(store,giftFromXml('gift',{ts:'2',user:'TEST',giftname:'SAMPLE',giftcount:'1',total_price:'198'},source,1));

  const bounds = [];
  const work = media.work.bind(media);
  for (const giftsEnabled of [false,true]) {
    media.work = () => {};
    const job = await media.enqueue(session.id, { scope:'clips', ranges:[{start:0,end:6}], mode:'danmaku',
      giftsEnabled, exportDirectory:path.join(root, 'out') });
    media.work = work;
    await work();
    const row = store.get('SELECT * FROM jobs WHERE id=?', job.id);
    assert.equal(row.status, 'done', row.error);
    const pixels = execFileSync(ffmpeg, ['-v','error','-ss','4','-i',row.file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    let minY = height, maxY = -1, giftPixels = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      const [r,g,b] = [pixels[i],pixels[i+1],pixels[i+2]], x = i / 3 % width, y = Math.floor(i / 3 / width);
      if (g > 110 && g > 1.8*r && g > 1.8*b) { minY = Math.min(minY,y); maxY = Math.max(maxY,y); }
      if (x > width*.75 && y < height*.19 && r > g*1.3 && r > 31) giftPixels++;
    }
    assert.equal(giftPixels > 100, giftsEnabled);
    bounds.push(maxY-minY+1);
  }
  // WKWebView measured 32px with the same 640x360 frame and selected scale.
  // Allow for fallback-font and rasterization differences across runtimes.
  assert.ok(bounds[0] >= 26 && bounds[0] <= 39, `unexpected rendered text heights: ${bounds}`);
  if (process.platform === 'darwin') assert.ok(Math.abs(bounds[0]-32) <= 3, `macOS glyph height ${bounds[0]}`);
  assert.ok(Math.abs(bounds[0]-bounds[1]) <= 1, `gift toggle changed glyph height: ${bounds}`);
});
