import test from 'node:test';
import assert from 'node:assert/strict';
import {Recorder} from '../server/recorder.js';
import {roomStatus} from '../src/room-status.js';
import {recordingReason} from '../server/diagnostics.js';

function fixture(t){
  const settings=new Map(),calls=[],logs=[];let clock=0;
  const room=id=>({roomId:id,recording:true,streaming:true,autoRecord:true,autoRecordForThisSession:true,
    recordingStats:{totalOutputBytes:1000,sessionMaxTimestamp:1000}});
  const rooms=[room(42),room(43)];
  const store={root:'/unused',setting(key,value){if(value!==undefined)settings.set(key,value);return settings.get(key);},all(){return [];},run(){},
    diagnostics:{protectSecret(){},record(...args){logs.push(args);}}};
  const recorder=new Recorder(store,{lifecycle:{progressNow:()=>clock}});recorder.online=true;
  recorder.reconcile=async()=>{};
  recorder.api=async(route,body)=>{
    calls.push({route,body});
    if(route==='room')return structuredClone(rooms);
    if(route.endsWith('/start')){
      const raw=rooms.find(r=>r.roomId===Number(route.split('/')[1]));raw.recording=true;raw.autoRecordForThisSession=true;
      raw.recordingStats={totalOutputBytes:0,sessionMaxTimestamp:0};
    }
    // Stop deliberately does not finish the writer; tests must confirm it separately.
    return null;
  };
  t.after(()=>recorder.close());
  async function tick(ms){clock=ms;rooms[1].recordingStats.totalOutputBytes+=1000;rooms[1].recordingStats.sessionMaxTimestamp+=2000;await recorder.poll();}
  const controls=()=>calls.filter(c=>c.route!=='room');
  return {recorder,rooms,calls,logs,tick,controls};
}

test('实际 poll 在 30 秒停止冻结房间，等待旧写入结束再启动，不动健康房间',async t=>{
  const {recorder,rooms,logs,tick,controls}=fixture(t);
  await tick(0);await tick(8000);
  assert.match(roomStatus(recorder.rooms[0]),/进度停滞/);
  assert.match(recordingReason(recorder.rooms[0]),/进度停滞/);
  await tick(30000);assert.deepEqual(controls().map(c=>c.route),['room/42/stop']);
  await tick(40000);assert.match(roomStatus(recorder.rooms[0]),/安全停止/);
  assert.equal(controls().length,1);
  rooms[0].recording=false;await tick(42000);
  assert.deepEqual(controls().map(c=>c.route),['room/42/stop','room/42/start']);
  await tick(44000);assert.match(roomStatus(recorder.rooms[0]),/等待有效录制/);
  rooms[0].recordingStats={totalOutputBytes:500,sessionMaxTimestamp:2000};await tick(46000);
  assert.equal(roomStatus(recorder.rooms[0]),'正在录制');
  assert.ok(logs.some(([,text])=>text.includes('有效录制已恢复')));
  assert.ok(logs.every(([,text])=>!text.includes('undefined')));
});

test('短暂波动自行恢复，随后 40 分钟的持续音视频推进不会重启',async t=>{
  const {rooms,tick,controls}=fixture(t);await tick(0);await tick(8000);
  for(let ms=10000;ms<=2400000;ms+=2000){rooms[0].recordingStats.totalOutputBytes+=100;rooms[0].recordingStats.sessionMaxTimestamp+=2000;await tick(ms);}
  assert.deepEqual(controls(),[]);
});

test('只有字节增长、时间不增长仍触发恢复；切片/重启计数归零本身不算成功',async t=>{
  const {rooms,tick,controls}=fixture(t);await tick(0);
  rooms[0].recordingStats.totalOutputBytes+=1000;await tick(20000);
  rooms[0].recordingStats={totalOutputBytes:0,sessionMaxTimestamp:0};await tick(28000);
  await tick(30000);assert.equal(controls()[0].route,'room/42/stop');
});

test('恢复期间用户停止，之后旧任务退出也不被重新启动',async t=>{
  const {recorder,rooms,tick,controls}=fixture(t);await tick(0);await tick(30000);
  await recorder.stopRoom(42);rooms[0].recording=false;rooms[0].autoRecord=false;rooms[0].autoRecordForThisSession=false;
  await tick(40000);await tick(100000);
  assert.equal(recorder.roomState.get(42).enabled,false);
  assert.equal(controls().some(c=>c.route==='room/42/start'),false);
});

test('停止请求超时后不得并发启动，按 30 秒间隔重试，退出后不再恢复',async t=>{
  const {recorder,tick,controls}=fixture(t);const api=recorder.api;
  recorder.api=async(...args)=>{const result=await api(...args);if(args[0].endsWith('/stop'))throw new Error('timeout');return result;};
  await tick(0);await tick(30000);await tick(40000);await tick(59000);
  assert.equal(controls().length,1);assert.equal(recorder.online,true);
  await tick(60000);assert.deepEqual(controls().map(c=>c.route),['room/42/stop','room/42/stop']);
  recorder.quitting=true;await tick(100000);assert.equal(controls().length,2);
});

test('兜底启动失败后限频重试，不会持续请求',async t=>{
  const {recorder,rooms,tick,controls}=fixture(t);
  const api=recorder.api;recorder.api=async(...args)=>{const value=await api(...args);if(args[0].endsWith('/start'))rooms[0].recording=false;return value;};
  await tick(0);await tick(30000);rooms[0].recording=false;await tick(32000);
  await tick(61000);assert.equal(controls().length,2);
  await tick(62000);assert.equal(controls().length,3);
});

test('核心因标题过滤等策略没有创建录制任务时，兜底不强行重启',async t=>{
  const {rooms,tick,controls}=fixture(t);rooms[0].recording=false;
  await tick(0);await tick(100000);assert.deepEqual(controls(),[]);
});

test('无可用统计的旧核心、未开播房间不被误重启',async t=>{
  const {rooms,tick,controls}=fixture(t);delete rooms[0].recordingStats;
  await tick(0);await tick(100000);assert.deepEqual(controls(),[]);
  rooms[0].recording=false;rooms[0].streaming=false;await tick(200000);assert.deepEqual(controls(),[]);
});

test('原始录制模式通过每次新的写盘统计确认推进',async t=>{
  const {rooms,tick,controls}=fixture(t);rooms[0].recordingStats={totalOutputBytes:0,sessionMaxTimestamp:0};
  for(let ms=0;ms<120000;ms+=2000){rooms[0].ioStats={diskBytesWritten:1000,endTime:String(ms)};await tick(ms);}
  assert.deepEqual(controls(),[]);
});
