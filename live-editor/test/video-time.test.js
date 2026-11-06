import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedSpan, formatVideoTime, markPreviewPosition, formatFrameTime, frameTimePosition, formatFrameDuration, latestPreviewPosition } from '../src/video-time.js';

test('30帧与24帧逐帧累加到整秒时，毫秒进位不会输出1000或把切点变成0.1秒', () => {
  for (const fps of [30, 24]) {
    let position = 0;
    for (let frame = 0; frame < fps; frame++) position += 1 / fps;
    assert.ok(position < 1 && position > .999999);
    const formatted = formatVideoTime(position, true);
    assert.equal(formatted, '00:00:01.000');
    assert.equal(formatted.split(':').map(Number).reduce((total, field) => total * 60 + field, 0), 1);
  }
});

test('毫秒取整正确处理秒、分和小时边界，且始终只有三位小数', () => {
  for (const [value, expected] of [[.9995, '00:00:01.000'], [59.9996, '00:01:00.000'], [3599.9996, '01:00:00.000'], [86399.9996, '24:00:00.000']]) {
    assert.equal(formatVideoTime(value, true), expected);
    assert.match(formatVideoTime(value, true), /\.\d{3}$/);
  }
});

test('普通毫秒精度保持，亚毫秒统一取最近整毫秒', () => {
  for (const [value, expected] of [[0, '00:00:00.000'], [.001, '00:00:00.001'], [.123, '00:00:00.123'], [1.234, '00:00:01.234'], [359.999, '00:05:59.999'], [3600.123, '01:00:00.123'], [1 / 60, '00:00:00.017']]) assert.equal(formatVideoTime(value, true), expected);
  assert.equal(formatVideoTime(.0004, true), '00:00:00.000');
  assert.equal(formatVideoTime(.0005, true), '00:00:00.001');
});

test('不显示毫秒时四舍五入到秒，时长与起止点的显示一致', () => {
  assert.equal(formatVideoTime(.4), '00:00:00');
  assert.equal(formatVideoTime(.5), '00:00:01');
  assert.equal(formatVideoTime(7.4), '00:00:07');
  assert.equal(formatVideoTime(12.6), '00:00:13');
  assert.equal(displayedSpan(7.4, 12.6), 6);
  assert.equal(formatVideoTime(displayedSpan(7.4, 12.6)), '00:00:06');
  assert.equal(formatVideoTime(59.5), '00:01:00');
  assert.equal(formatVideoTime(3599.5), '01:00:00');
  assert.equal(formatVideoTime(360000.4), '100:00:00');
  for (const value of [-1, undefined, NaN, Infinity, 'invalid']) assert.equal(formatVideoTime(value), '00:00:00');
  assert.equal(formatVideoTime('1.234', true), '00:00:01.234');
});

test('断流前精确终点只回退预览一帧，连续边界照常显示下一段',()=>{
  const first={start:0,duration:60,metadata:{fps:25}},next={start:120,duration:60};
  assert.equal(markPreviewPosition(60,[first,next]),59.96);
  assert.equal(markPreviewPosition(60,[first,{...next,start:60}]),60);
  assert.equal(markPreviewPosition(30,[first,next]),30);
  assert.equal(markPreviewPosition(90,[first,next]),90);
  assert.equal(markPreviewPosition(.01,[{start:0,duration:.01}]),0);
  assert.equal(markPreviewPosition(180,[first,next]),180-1/30);
});


test('剪辑时间码在非整数帧率与高帧率下仍区分相邻帧并可往返',()=>{
  for(const rate of [24,25,30000/1001,60000/1001,120,240]){
    const labels=new Set();
    for(let frame=0;frame<rate*3;frame++){
      const time=3600+frame/rate,label=formatFrameTime(time,rate);
      assert.ok(!labels.has(label),`${rate} fps repeats ${label}`);labels.add(label);
      const [h,m,s,f]=label.split(':').map(Number);
      assert.ok(Math.abs(frameTimePosition(h*3600+m*60+s,f,rate)-time)<=.5/rate+1e-8,label);
    }
  }
  assert.equal(formatFrameDuration(1/60,60),'00:00:00:01');
  assert.equal(formatFrameDuration(.001,60),'< 00:00:00:01');
  assert.ok(Number.isNaN(frameTimePosition(12,25,25)));
});

test('回到最新使用最后已索引的来源，保留一帧内的解码余量',()=>{
  const sources=[{start:15,duration:4.1,metadata:{fps:25}},{start:0,duration:5},{start:21,duration:0}];
  assert.ok(Math.abs(latestPreviewPosition(sources,25)-19.06)<1e-8);
  assert.ok(Math.abs(latestPreviewPosition(sources,18)-17.96)<1e-8);
  assert.equal(latestPreviewPosition([],25),null);
});
