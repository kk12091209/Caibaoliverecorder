#!/usr/bin/env node
// Node 24+. No database or media files are opened; --before is read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {scrollingTracks} from '../shared/danmaku-tracks.js';
import {danmakuGeometry} from '../shared/danmaku-style.js';
import {overlapExposure} from '../test/helpers/danmaku-overlap.js';

const options={};
for(let i=2;i<process.argv.length;i+=2){assert.ok(process.argv[i].startsWith('--')&&process.argv[i+1]);options[process.argv[i].slice(2)]=process.argv[i+1];}
assert.ok(options.before&&options.output,'Use --before /path/to/previous/live-editor --output /path/to/new.json');
const previous=await import(pathToFileURL(path.resolve(options.before,'shared/danmaku-tracks.js')).href);
const results=[];
for(const initial of [415,17,42123,2026]){
  let seed=initial;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const rate of [15,30,50])for(const areaHeight of [1,1/3])for(const burst of [false,true]){
    const raw=Array.from({length:rate*24},(_,i)=>({id:String(i).padStart(6,'0'),time:burst?Math.floor(i/rate):i/rate,text:'测'.repeat(2+Math.floor(random()*25))}));
    const style={size:.6,opacity:100,speed:1,fps:60,areaTop:areaHeight===1?0:.4,areaHeight};
    const geometry=danmakuGeometry(1080,style),config={width:1920,height:1080,...geometry,duration:6};
    const before=previous.scrollingTracks(raw,config),after=scrollingTracks(raw,config);
    assert.deepEqual(after.map(({id,time,text,textWidth,speed,entryDelay,end})=>[id,time,text,textWidth,speed,entryDelay,end]),before.map(({id,time,text,textWidth,speed,entryDelay,end})=>[id,time,text,textWidth,speed,entryDelay,end]));
    const old=overlapExposure(before,1920,geometry.size*1.4+4),next=overlapExposure(after,1920,geometry.size*1.4+4);
    results.push({seed:initial,rate,areaHeight,burst,comments:raw.length,before:old,after:next,reduction:1-next.total/old.total});
  }
}
await fs.writeFile(path.resolve(options.output),JSON.stringify({created:new Date().toISOString(),node:process.version,results},null,2),{flag:'wx'});
console.log(JSON.stringify({cases:results.length,minReduction:Math.min(...results.map(x=>x.reduction)),maxReduction:Math.max(...results.map(x=>x.reduction)),invariants:'count, text, width, time, speed, delay and duration identical'}));
