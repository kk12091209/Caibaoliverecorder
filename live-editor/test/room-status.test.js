import test from 'node:test';
import assert from 'node:assert/strict';
import {roomRecordEnabled,roomStatus} from '../src/room-status.js';

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
