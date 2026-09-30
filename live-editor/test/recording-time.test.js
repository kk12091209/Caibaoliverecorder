import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {recordingTimeAt,positionAtRecordingTime,toRecordingInput,parseRecordingInput,recordingTimeBounds} from '../src/recording-time.js';
const session={created:'2026-09-28T13:30:00.123Z',duration:600,status:'finished'};
const epoch=Date.parse(session.created);
const source={start:0,duration:600,wall:session.created};
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.000001,`${actual} != ${expected}`);

test('北京时间输入严格校验并保留毫秒，不受电脑时区影响',()=>{
  assert.equal(toRecordingInput(epoch),'2026-09-28T21:30:00.123');
  assert.equal(parseRecordingInput('2026-09-28T21:30:00.123'),epoch);
  assert.equal(parseRecordingInput('2026-09-28T21:30'),epoch-123);
  assert.equal(parseRecordingInput('2026-09-28T21:30:00.1'),epoch-23);
  assert.equal(toRecordingInput(parseRecordingInput('2024-02-29T23:59:59.999')),'2024-02-29T23:59:59.999');
  for(const value of ['','2026-02-29T12:00','2026-04-31T12:00','2026-13-01T12:00','2026-09-28T24:00','2026-09-28T12:60','2026-09-28T12:00:60','2026-09-28T12:00:00.1234','2026-09-28T12:00Z','2026-09-28','0000-01-01T00:00',null,NaN])assert.throws(()=>parseRecordingInput(value),/有效的录制日期和时间/);
  assert.throws(()=>toRecordingInput(Infinity),/有效/);
});
test('正常录像使用source.wall锚点，起点终点和毫秒均可往返',()=>{
  for(const seconds of [0,.001,.123,1.234,359.999,600]){const value=recordingTimeAt(seconds,session,[source]);assert.equal(value,epoch+seconds*1000);close(positionAtRecordingTime(value,session,[source],600),seconds);}
  assert.deepEqual(recordingTimeBounds(session,[source],600),{min:epoch,max:epoch+600000});
  assert.equal(recordingTimeAt(-1,session,[source]),null);assert.equal(recordingTimeAt(NaN,session,[source]),null);assert.equal(recordingTimeAt(600.01,session,[source]),null);
});
test('源时钟偏移优先于整场起点，源缺失时才使用session.created',()=>{
  const sources=[{start:0,duration:60,wall:session.created},{start:300,duration:300,wall:'2026-09-28T21:35:02.123+08:00'}];
  assert.equal(recordingTimeAt(358,session,sources),epoch+360000);
  close(positionAtRecordingTime(epoch+360000,session,sources,600),358);
  assert.equal(recordingTimeAt(315,session,[{start:300,duration:300,wall:'invalid'}]),epoch+315000);
  assert.equal(recordingTimeAt(1.234,session,[]),epoch+1234);
  close(positionAtRecordingTime(epoch+1234,session,[],600),1.234);
  assert.equal(recordingTimeAt(0,{created:'invalid',duration:5},[]),null);
  assert.equal(recordingTimeAt(2,{},[{start:0,duration:5,wall:session.created}]),epoch+2000);
});
test('跨午夜与跨年使用完整日期，不把次日时间定位到前一天',()=>{
  const overnight={created:'2026-12-31T23:59:59.900+08:00',duration:5,status:'finished'};
  const wall=recordingTimeAt(.2,overnight,[]);assert.equal(toRecordingInput(wall),'2027-01-01T00:00:00.100');
  close(positionAtRecordingTime(parseRecordingInput('2027-01-01T00:00:00.100'),overnight,[],5),.2);
});
test('断流间隙、素材之前与未来时间明确报错，不自动跳转',()=>{
  const sources=[{start:0,duration:60,wall:session.created},{start:120,duration:60,wall:new Date(epoch+120000).toISOString()}],recording={...session,duration:180,status:'recording'};
  assert.equal(recordingTimeAt(90,recording,sources),null);
  assert.throws(()=>positionAtRecordingTime(epoch+90000,recording,sources,180),/断流或未录制/);
  assert.throws(()=>positionAtRecordingTime(epoch-1,recording,sources,180),/早于/);
  assert.throws(()=>positionAtRecordingTime(epoch+180001,recording,sources,180),/尚未录制/);
  assert.throws(()=>positionAtRecordingTime(epoch+180001,{...recording,status:'finished'},sources,180),/晚于/);
  assert.equal(recordingTimeAt(60,recording,sources),epoch+60000);
  close(positionAtRecordingTime(epoch+60000,recording,sources,180),60);
  close(positionAtRecordingTime(epoch+120000,recording,sources,180),120);
  assert.throws(()=>positionAtRecordingTime(epoch,{},[],0),/还没有/);
});
test('相邻源边界不误报重叠；真实时间回退对应不同位置必须拒绝',()=>{
  const adjoining=[{start:0,duration:60,wall:session.created},{start:60,duration:60,wall:new Date(epoch+60000).toISOString()}];
  close(positionAtRecordingTime(epoch+60000,{...session,duration:120},adjoining,120),60);
  const overlapping=[{start:0,duration:60,wall:session.created},{start:60,duration:60,wall:new Date(epoch+30000).toISOString()}];
  assert.throws(()=>positionAtRecordingTime(epoch+45000,{...session,duration:120},overlapping,120),/多个视频位置.*视频时间/);
  assert.equal(recordingTimeAt(60,{...session,duration:120},overlapping),epoch+30000);
});
test('只使用已录制的来源长度，新增来源不会重新锚定已有时间',()=>{
  const live={...session,duration:600,status:'recording'},first={start:0,duration:30,wall:session.created};
  assert.deepEqual(recordingTimeBounds(live,[first],600),{min:epoch,max:epoch+30000});
  assert.throws(()=>positionAtRecordingTime(epoch+60000,live,[first],600),/尚未录制/);
  const before=recordingTimeAt(10.123,live,[first]);
  const after=recordingTimeAt(10.123,live,[first,{start:40,duration:60,wall:new Date(epoch+43000).toISOString()}]);assert.equal(before,after);
  assert.deepEqual(recordingTimeBounds(live,[source],20),{min:epoch,max:epoch+20000});
});
test('北京时间格式化和无时区元数据解析在不同OS时区结果一致',()=>{
  const module=fileURLToPath(new URL('../src/recording-time.js',import.meta.url));
  const program=`import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);console.log(JSON.stringify([m.parseRecordingInput('2026-09-28T21:30:00.123'),m.toRecordingInput(1790602200123),m.recordingTimeAt(1.234,{created:'2026-09-28T21:30:00.123',duration:10},[])]));`;
  const values=['UTC','America/New_York','Asia/Shanghai'].map(TZ=>execFileSync(process.execPath,['--input-type=module','-e',program,module],{env:{...process.env,TZ},windowsHide:true}).toString().trim());
  assert.equal(values[0],values[1]);assert.equal(values[0],values[2]);
});
