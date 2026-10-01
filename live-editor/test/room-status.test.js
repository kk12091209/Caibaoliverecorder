import test from 'node:test';
import assert from 'node:assert/strict';
import {roomAvailable,roomRecordEnabled,roomStatus} from '../src/room-status.js';

test('直播间按钮分别使用 B站和抖音服务状态',()=>{
  const bili={platform:'bilibili'},douyin={platform:'douyin'};
  for(const biliOnline of [false,true])for(const douyinOnline of [false,true]){
    const recorder={online:biliOnline||douyinOnline,biliOnline,douyinOnline};
    assert.equal(roomAvailable(bili,recorder),biliOnline);
    assert.equal(roomAvailable(douyin,recorder),douyinOnline);
  }
});
test('仅有 online 的页面状态仍可显示原有 B站房间，抖音等待自身服务',()=>{
  for(const online of [false,true]){
    assert.equal(roomAvailable({}, {online}),online);
    assert.equal(roomAvailable({platform:'douyin'},{online}),false);
  }
});

test('等待开播的监控与手动停止使用不同按钮状态',()=>{
  const waiting={autoRecord:true,autoRecordForThisSession:true,streaming:false,recording:false};
  assert.equal(roomRecordEnabled(waiting),true);assert.equal(roomStatus(waiting),'监控中 · 等待开播');
  const stopped={...waiting,autoRecordForThisSession:false};
  assert.equal(roomRecordEnabled(stopped),false);assert.equal(roomStatus(stopped),'已停止');
  assert.equal(roomRecordEnabled({...stopped,streaming:true}),false);
  assert.equal(roomStatus({...stopped,streaming:true}),'直播中 · 已停止录制');
});
test('录制中优先显示停止，等待重连保持启用，关闭自动录制的离线房间显示开始',()=>{
  assert.equal(roomRecordEnabled({recording:true,autoRecord:false,autoRecordForThisSession:false}),true);
  assert.equal(roomStatus({recording:true}),'正在录制');
  assert.equal(roomRecordEnabled({autoRecord:true,autoRecordForThisSession:true,streaming:true}),true);
  assert.equal(roomStatus({autoRecord:true,autoRecordForThisSession:true,streaming:true}),'正在准备录制');
  assert.equal(roomRecordEnabled({autoRecord:false,autoRecordForThisSession:true,recording:false}),false);
});

test('持久化的 B站停止状态优先于核心重置的临时标记，手动启用仍可显示停止',()=>{
  const room={platform:'bilibili',autoRecord:true,autoRecordForThisSession:true,recordingEnabled:false,recording:false};
  assert.equal(roomRecordEnabled(room),false);assert.equal(roomStatus(room),'已停止');
  assert.equal(roomRecordEnabled({...room,recordingEnabled:true,autoRecord:false}),true);
  assert.equal(roomRecordEnabled({...room,recording:true}),true);
});
