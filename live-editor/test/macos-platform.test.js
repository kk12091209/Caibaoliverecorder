import test from 'node:test';
import assert from 'node:assert/strict';
import {macCorePort} from '../server/local-endpoint.js';
import {detectExportEncoder} from '../server/export-encoding.js';
const identity={executable:'/Applications/菜播·录包机.app/Contents/Resources/runtime/recorder/BililiveRecorder.Cli',directory:'/Users/example/Library/Application Support/Caibo/data/originals'};
const command=`${identity.executable} run --http-bind http://127.0.0.1:18001 --http-basic-user editor --http-basic-pass ${'a'.repeat(48)} --enable-file-browser false ${identity.directory}`;
test('Mac ownership accepts only the exact core launch and originals directory',()=>{
  assert.equal(macCorePort(command,identity),18001);
  for(const changed of [command+' backup',command.replace('18001','6000'),command.replace('editor','other'),command.replace('false','true'),'/other'+command])assert.equal(macCorePort(changed,identity),null);
  assert.equal(macCorePort(command,{...identity,directory:'/Users/example/other'}),null);
});
test('Mac encoder uses two real VideoToolbox outputs and falls back on failure',async()=>{
  const calls=[];
  const encoder=await detectExportEncoder(async args=>{calls.push(args);},{platform:'darwin'});
  assert.equal(encoder.id,'h264_videotoolbox');assert.equal(calls.length,1);
  assert.equal(calls[0].filter(x=>x==='h264_videotoolbox').length,2);
  const fallback=await detectExportEncoder(async()=>{throw Error('hardware unavailable');},{platform:'darwin'});
  assert.equal(fallback.id,'libx264');
});
