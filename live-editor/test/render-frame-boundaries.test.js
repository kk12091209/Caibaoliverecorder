import test from 'node:test';
import assert from 'node:assert/strict';
import {renderBlocks,frameSpan,RenderPipeline} from '../server/render-plan.js';

test('real 60.014-second source at 4090.976 keeps its ready block and omits only the zero-frame tail',async()=>{
  const source={id:'recorded',start:4090.976,duration:60.014};
  const blocks=renderBlocks([source]);
  assert.deepEqual(blocks.map(({startMs,endMs})=>[startMs,endMs]),[[4090976,4150976]]);
  let acquired=0,released=0;
  const renderer=new RenderPipeline({store:{edit:()=>({})},renderCache:{acquire:async()=>{acquired++;return {bytes:123,release:async()=>released++};}}},()=> '');
  renderer.describe=async()=>({blocks});renderer.spec=async(_plan,block)=>block;
  renderer.acquire=async()=>{throw Error('Existing complete block must be reused');};
  const result=await renderer.prepareNext('session');
  assert.equal(result.done,true);assert.equal(result.preparedSeconds,result.totalSeconds);
  assert.equal(result.totalSeconds,frameSpan(source.start,source.start+source.duration).duration);
  assert.equal(acquired,1);assert.equal(released,1);
});

test('millisecond boundaries preserve the exact total frame count, including short tails that do contain one frame',()=>{
  for(let ms=0;ms<100;ms++)for(let tail=1;tail<40;tail++){
    const source={start:4000+ms/1000,duration:60+tail/1000};
    const blocks=renderBlocks([source]);
    assert.ok(blocks.every(b=>frameSpan(b.startMs/1000,b.endMs/1000).frames>0));
    // Source time is persisted on the existing millisecond cache grid.
    assert.equal(blocks.reduce((n,b)=>n+frameSpan(b.startMs/1000,b.endMs/1000).frames,0),frameSpan(Math.round(source.start*1000)/1000,Math.round((source.start+source.duration)*1000)/1000).frames);
    assert.equal(blocks[0].startMs,Math.round(source.start*1000));
    assert.equal(blocks[0].endMs,Math.round(source.start*1000)+60000);
  }
});
