import test from 'node:test';
import assert from 'node:assert/strict';
import {recorderStatusDetails} from '../src/recorder-status.js';
const online={biliOnline:true,douyinOnline:true};
const details=(rooms,recorder=online,connected=true,anchors=[])=>recorderStatusDetails(recorder,rooms,connected,anchors);

test('平台只有服务就绪或未连接，空平台只给一条短提示',()=>{
 const rows=details([]);assert.deepEqual(rows.map(row=>row.status),['服务就绪','服务就绪']);
 assert.ok(rows.every(row=>row.idle==='尚未添加直播间'&&!row.rooms.length&&!row.failed));
});
test('B站视频录制和弹幕连接独立显示，只有明确失败状态标危险色',()=>{
 const room=details([{roomId:1,recording:true,danmakuConnected:false}])[0].rooms[0];
 assert.equal(room.video,'录制中');assert.equal(room.videoFailed,false);assert.equal(room.chat,'未连接');assert.equal(room.chatFailed,true);
 const rows=details([{roomId:1,recording:true,danmakuConnected:true},{roomId:2,recording:true}])[0].rooms;
 assert.equal(rows[0].chat,'已连接');assert.equal(rows[0].chatFailed,false);assert.equal(rows[1].chat,'待确认');assert.equal(rows[1].chatFailed,false);
});
test('已停视频仍可有弹幕连接，不再附加直播中或当前未录制说明',()=>{
 const room=details([{roomId:1,recording:false,streaming:true,recordingEnabled:false,danmakuConnected:true}])[0].rooms[0];
 assert.equal(room.video,'未录');assert.equal(room.chat,'已连接');assert.equal(room.chatFailed,false);
});
test('视频错误显示短失败，完整原因留作提示',()=>{
 const room=details([{roomId:1,recording:false,error:'原始详细错误：磁盘空间不足'}])[0].rooms[0];
 assert.equal(room.video,'失败');assert.equal(room.videoFailed,true);assert.equal(room.videoHint,'原始详细错误：磁盘空间不足');
});
test('抖音没有明确连接信息时保留待确认，不把无错误或写入错误当作连通证据',()=>{
 const room={platform:'douyin',roomId:'douyin:1',recording:true};
 for(const chatError of ['', '弹幕保存失败。']){
  const row=details([{...room,chatError}])[1].rooms[0];assert.equal(row.chat,'待确认');assert.equal(row.chatFailed,false);assert.equal(row.chatHint,chatError);
 }
});
test('抖音接收和写入阶段统一显示连接状态，采集观察字段不被修改',()=>{
 const room={platform:'douyin',roomId:'douyin:1',recording:true};
 const label=chatStatus=>details([{...room,chatStatus}])[1].rooms[0].chat;
 assert.equal(label({connection:'connecting'}),'待确认');assert.equal(label({connection:'unknown'}),'待确认');
 for(const extra of [{},{received:true},{received:true,written:true},{written:true,writeFailed:true}])assert.equal(label({connection:'connected',...extra}),'已连接');
 for(const connection of ['retrying','stopped']){
  const row=details([{...room,chatStatus:{connection}}])[1].rooms[0];assert.equal(row.chat,'未连接');assert.equal(row.chatFailed,true);
 }
});
test('抖音停录后没有活动连接显示中性的待机，不误报连接故障',()=>{
 const room=details([{platform:'douyin',roomId:'douyin:1',recording:false,recordingEnabled:false}])[1].rooms[0];
 assert.equal(room.video,'未录');assert.equal(room.chat,'待机');assert.equal(room.chatFailed,false);
});
test('两平台对待机、连接、采集中断开和待确认采用相同的词与危险色规则',()=>{
 const cases=[
  {recording:false,bili:{danmakuConnected:false},douyin:{chatStatus:{connection:'stopped'}},chat:'待机',failed:false},
  {recording:false,bili:{},douyin:{},chat:'待机',failed:false},
  {recording:false,bili:{danmakuConnected:true},douyin:{chatStatus:{connection:'connected'}},chat:'已连接',failed:false},
  {recording:true,bili:{danmakuConnected:true},douyin:{chatStatus:{connection:'connected'}},chat:'已连接',failed:false},
  {recording:true,bili:{danmakuConnected:false},douyin:{chatStatus:{connection:'retrying'}},chat:'未连接',failed:true},
  {recording:true,bili:{},douyin:{chatStatus:{connection:'connecting'}},chat:'待确认',failed:false}
 ];
 for(const scenario of cases){
  const platforms=details([{platform:'bilibili',roomId:1,recording:scenario.recording,...scenario.bili},{platform:'douyin',roomId:'douyin:1',recording:scenario.recording,...scenario.douyin}]);
  for(const room of platforms.flatMap(row=>row.rooms)){assert.equal(room.chat,scenario.chat);assert.equal(room.chatFailed,scenario.failed);}
 }
});
test('服务失联只报告服务未连接，不把旧房间快照继续显示为正常',()=>{
 const rooms=[{roomId:1,recording:true,danmakuConnected:true},{platform:'douyin',roomId:'douyin:2',recording:true,chatStatus:{connection:'connected'}}];
 const rows=details(rooms,{biliOnline:false,douyinOnline:true,error:'连接失败'});
 assert.equal(rows[0].status,'未连接');assert.equal(rows[0].failed,true);assert.equal(rows[0].rooms.length,0);assert.equal(rows[0].idle,'');assert.equal(rows[0].error,'连接失败');
 assert.equal(rows[1].rooms[0].chat,'已连接');
 for(const row of details(rooms,online,false)){assert.equal(row.status,'未连接');assert.equal(row.failed,true);assert.equal(row.rooms.length,0);assert.equal(row.idle,'');}
});
test('已添加但停录的抖音监控仍列在平台下，不误称尚未添加',()=>{
 const anchor={platform:'douyin',key:'douyin-user:1',ownWebRid:'123',name:'已添加主播',recording:false};
 const row=details([],online,true,[anchor])[1];assert.equal(row.idle,'');assert.equal(row.rooms.length,1);assert.equal(row.rooms[0].name,'已添加主播');assert.equal(row.rooms[0].video,'未录');assert.equal(row.rooms[0].chat,'待机');assert.equal(row.rooms[0].chatFailed,false);
});
test('房间和主播快照去重，同房间连线不会变成重复状态卡',()=>{
 const rooms=[{platform:'douyin',roomId:'douyin:456',webRid:'456',name:'实际房间',recording:true,chatStatus:{connection:'connected'}}];
 const anchors=[{platform:'douyin',key:'douyin-user:1',ownWebRid:'123',webRid:'456',name:'被监控主播',recording:true}];
 assert.equal(details(rooms,online,true,anchors)[1].rooms.length,1);
 assert.equal(details([{roomId:1}],online,true,[{platform:'bilibili',roomId:1,name:'同一个房间'}])[0].rooms.length,1);
});
test('汇总只读快照，所有可见状态来自限定短词',()=>{
 const chatStatus=Object.freeze({connection:'connected',written:true,writeFailed:true});
 const room=Object.freeze({platform:'douyin',roomId:'douyin:1',recording:true,chatStatus});const anchors=Object.freeze([Object.freeze({platform:'douyin',key:'douyin-user:2',ownWebRid:'2',name:'主播',recording:false})]);
 const rows=details(Object.freeze([room]),Object.freeze({...online}),true,anchors);
 for(const row of rows.flatMap(platform=>platform.rooms)){assert.ok(['录制中','未录','失败'].includes(row.video));assert.ok(['已连接','未连接','待确认','待机'].includes(row.chat));}
 assert.equal(chatStatus.writeFailed,true);
});
