import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingCoverage} from '../src/recording-coverage.js';
import {audioStateLabel} from '../src/timeline-signals.js';

test('两小段之间的 30 分钟空档明确显示，原时间坐标不变',()=>{
  const sources=[{start:0,duration:3.712,closed:2},{start:1910.279,duration:3.712,closed:2}];
  const result=recordingCoverage(sources,1913.991);
  assert.deepEqual(result.gaps,[{start:3.712,end:1910.279}]);
  assert.ok(Math.abs(result.available-7.424)<.0001);
  assert.ok(result.missing>1906);
  assert.equal(sources[1].start,1910.279);
});
test('整理中或正在录制的文件不因尚未完成索引被标为空档',()=>{
  for(const closed of [0,1]){
    assert.deepEqual(recordingCoverage([{start:0,duration:2,closed},{start:100,duration:3,closed:2}],103).gaps,[]);
    assert.deepEqual(recordingCoverage([{start:0,duration:2,closed}],103).gaps,[]);
  }
});
test('连续片段、重叠片段与小于一秒的边界误差不产生缺失警告',()=>{
  const result=recordingCoverage([{start:0,duration:10,closed:2},{start:5,duration:10,closed:2},{start:15.05,duration:5,closed:2}],20.05);
  assert.deepEqual(result.gaps,[]);assert.equal(result.available,20);
  assert.deepEqual(recordingCoverage([],40).gaps,[]);
});
test('部分波形不可读不再与正常静音混同',()=>{
  assert.equal(audioStateLabel({bins:[{state:'ready'},{state:'unavailable'}]},{selected:true}),'音频波形 · 部分区间无法读取');
  assert.equal(audioStateLabel({bins:[{state:'silent'}]},{selected:true}),'音频静音');
});
