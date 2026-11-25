import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoredAnchorStatus,roomAvailable,roomRecordEnabled,roomStatus} from '../src/room-status.js';

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

test('三个平台已开播但尚未开始写入时，卡片区别于等待开播、主动停止和录制中',()=>{
  for(const platform of ['bilibili','douyin','xiaohongshu']){
    const waiting={platform,legacy:platform==='bilibili',enabled:true,recordingEnabled:true,recording:false,streaming:true};
    const status=monitoredAnchorStatus(waiting);
    assert.equal(status.label,'已开播，等待录制');
    assert.equal(status.warning,'');
    assert.equal(monitoredAnchorStatus({...waiting,streaming:false}).label,'监控中');
    assert.equal(monitoredAnchorStatus({...waiting,enabled:false,recordingEnabled:false}).label,'已停止');
    assert.equal(monitoredAnchorStatus({...waiting,recording:true}).label,'直播录制中');
    const failed=monitoredAnchorStatus({...waiting,error:'暂未取得录制线路。'});
    assert.equal(failed.label,status.label);
    assert.equal(failed.warning,'暂未取得录制线路。');
  }
});

test('后台恢复原因仍优先显示，已停止跟录的抖音主播保持安静的监控状态',()=>{
  const live={platform:'xiaohongshu',enabled:true,streaming:true,recording:false,
    state:'监控中，等待核验开播状态',recordingHealth:{message:'正在恢复 · 等待有效录制'}};
  assert.deepEqual(monitoredAnchorStatus(live),{recording:false,label:'正在恢复录制',detail:live.recordingHealth.message,warning:live.recordingHealth.message});
  for(const reason of ['本人直播间未开播，连麦状态暂无法确认','状态接口未返回目标用户']){
    const offline={platform:'douyin',enabled:true,streaming:false,webRid:'',ownWebRid:'123',state:'待确认：'+reason};
    assert.deepEqual(monitoredAnchorStatus(offline),{recording:false,label:'监控中',detail:'监控中',warning:''});
  }
  assert.equal(monitoredAnchorStatus({platform:'douyin',enabled:true,recording:true,kind:'guest'}).label,'连线录制中');
});

test('B站已创建任务须等到首批媒体写入后亮起录制指示；兼容无进度数据的旧核心',()=>{
  const room={platform:'bilibili',legacy:true,enabled:true,recording:true,streaming:true};
  for(const [sample,written] of [
    [{recordingHasOutput:false},false],
    [{recordingHasOutput:false,recordingStats:{totalOutputBytes:0},ioStats:{networkBytesDownloaded:2048}},false],
    [{recordingHasOutput:true,recordingStats:{totalOutputBytes:0},ioStats:{diskBytesWritten:0}},true],
    [{recordingHasOutput:true,recording:false},false],
    [{recordingStats:{totalOutputBytes:0},ioStats:{networkBytesDownloaded:2048}},false],
    [{recordingStats:{totalOutputBytes:1024}},true],
    [{recordingStats:{totalOutputBytes:0},ioStats:{diskBytesWritten:1024}},true],
    [{recordingStats:null,ioStats:null},true],
    [{recordingStats:{totalOutputBytes:null}},true],
  ]){
    const status=monitoredAnchorStatus({...room,...sample});
    assert.equal(status.recording,written);
    assert.equal(status.label,written?'直播录制中':'已开播，等待录制');
  }
});
