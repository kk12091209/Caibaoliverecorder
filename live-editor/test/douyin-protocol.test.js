import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {decodePushFrame,decodeChat,decodeLottery,protobufInteger as n,protobufBytes as b,acknowledgeFrame,protobufFields,PROTOCOL_LIMITS} from '../server/douyin-protocol.js';
import {LotteryActivities} from '../server/lottery-activities.js';
import {ChatIntake} from '../server/chat-intake.js';
const join=(...parts)=>Buffer.concat(parts),roomId='7691637058724547364',start=1790850000000;
const message=(method,payload,id=9223372036854775807n)=>join(b(1,method),b(2,payload),n(3,id));
const chat=(text,id=1n,time=start)=>message('WebcastChatMessage',join(b(1,join(n(2,id),n(3,roomId),n(4,time/1000))),b(2,b(3,'观众')),b(3,text),n(15,time)),id);
const packet=messages=>join(n(2,9999999999999999999n),b(6,'gzip'),b(8,gzipSync(join(...messages.map(bytes=>b(1,bytes)),n(4,start),b(5,'ack-info'),n(9,1)))));

test('protobuf keeps 64-bit IDs, decompresses response and encodes ACK without precision loss',()=>{
 const frame=decodePushFrame(packet([chat('你好')]));assert.equal(frame.logId,9999999999999999999n);assert.equal(frame.needAck,true);
 const dto=decodeChat(frame.messages[0],{roomId,sourceStart:start});assert.equal(dto.text,'你好');assert.equal(dto.time,0);assert.equal(dto.user,'观众');
 const fields=[...protobufFields(acknowledgeFrame(frame.logId,frame.internalExt))];assert.equal(fields[0].value,frame.logId);assert.equal(fields[2].value.toString(),'ack-info');
 assert.equal(decodeChat(frame.messages[0],{roomId:'2',sourceStart:start}),null);
});
test('gift, like, entry and system messages are discarded before payload decoding or sampling',()=>{
 const irrelevant=['WebcastGiftMessage','WebcastLikeMessage','WebcastMemberMessage','WebcastSocialMessage','WebcastFansclubMessage','WebcastRoomMessage'];
 const frame=decodePushFrame(packet([...irrelevant.map(method=>message(method,Buffer.from([255,255,255]))),chat('普通重复'),chat('普通重复',2n)]));
 assert.equal(frame.messages.length,2);assert.deepEqual(frame.messages.map(message=>decodeChat(message,{roomId,sourceStart:start}).text),['普通重复','普通重复']);
});

test('福袋参与按 chat_by=9/10 过滤，无活动通知或相同普通文字也能区分',()=>{
 const phrase='点点关注，左上角福袋抽钻石';
 const marked=(by,id)=>message('WebcastChatMessage',join(b(1,join(n(2,id),n(3,roomId),n(4,start/1000))),b(2,b(3,'观众')),b(3,phrase),n(15,start/1000),n(20,by)),id);
 const frame=decodePushFrame(packet([marked(9,1),marked(10,2),marked(0,3),marked(5,4),marked(11,5)]));
 assert.deepEqual(frame.messages.map(item=>decodeChat(item,{roomId,sourceStart:start})?.id||null),[null,null,'3','4','5']);
});

test('普通 chat_tags 和优先级的 9/10 不当作福袋，漏过滤样本的 chat_by 才生效',()=>{
 for(const priority of [9,10]){
  const item={method:'WebcastChatMessage',id:'normal',payload:join(b(1,join(n(3,roomId),n(4,start/1000))),b(2,b(3,'观众')),b(3,'普通重复'),n(19,9),n(21,priority))};
  assert.equal(decodeChat(item,{roomId,sourceStart:start}).text,'普通重复');
 }
 // Sanitized live packet from 974612852909: ChatMessage 20=9, 21=30;
 // content need not mention a lottery, and event_time is in seconds.
 const sample={method:'WebcastChatMessage',id:'sample',payload:join(b(1,join(n(3,'7691664236002429705'),n(4,1790858127))),b(2,b(3,'观众')),b(3,'这是哪里'),n(15,1790858127),n(20,9),n(21,30))};
 assert.equal(decodeChat(sample,{roomId:'7691664236002429705',sourceStart:1790858110000}),null);
});

test('真实福袋弹幕的脱敏 protobuf 样本过滤；相同内容无参与标记时保留',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/douyin-fudai-chat.json',import.meta.url),'utf8'));
 for(const raw of fixture.messages){
  const payload=Buffer.from(raw.payload,'base64'),item={...raw,payload};
  assert.equal(decodeChat(item,{roomId:fixture.roomId,sourceStart:0}),null);
  const plain=Buffer.concat([...protobufFields(payload)].filter(field=>field.field!==20).map(field=>field.wire===0?n(field.field,field.value):b(field.field,field.value)));
  assert.equal(decodeChat({...item,payload:plain},{roomId:fixture.roomId,sourceStart:0}).text,'这是哪里');
 }
});

test('marked lottery flood is removed before reservoir limits and density, ordinary repeats remain',()=>{
 const intake=new ChatIntake({now:()=>start});intake.start('one',{start});
 const fields=join(b(1,join(n(3,roomId),n(4,start/1000))),b(2,b(3,'观众')),b(3,'口令'),n(20,9));
 for(let i=0;i<10000;i++){const dto=decodeChat({method:'WebcastChatMessage',id:String(i),payload:fields},{roomId,sourceStart:start});if(dto)intake.add('one',dto);}
 for(let i=0;i<50;i++){const dto=decodeChat(decodePushFrame(packet([chat('哈哈哈',BigInt(i+10000))])).messages[0],{roomId,sourceStart:start});intake.add('one',dto);}
 const batch=intake.take('one',{force:true});assert.equal(batch.messages.length,50);assert.equal(batch.density[0].count,50);assert.equal(intake.snapshot('one').recentIds,50);batch.release();
});

test('current flattened LotteryEventNewMessage reads comment type without description; room and status stay strict',()=>{
 const payload=join(b(1,n(3,roomId)),n(2,123),n(3,1),n(4,start/1000),n(5,start/1000+60),n(6,start/1000),
  b(21,join(n(1,3),b(2,'祝主播好运'))),b(21,join(n(1,4),b(2,'礼物条件'))));
 const item={method:'WebcastLotteryEventNewMessage',payload};
 const decoded=decodeLottery(item,{roomId,serverTime:start});assert.equal(decoded.length,1);assert.deepEqual(decoded[0].phrases,['祝主播好运']);
 const activities=new LotteryActivities({now:()=>start});assert.equal(activities.update('one',decoded[0]),true);
 assert.equal(activities.matches('one',{text:'祝主播好运',timestamp:start}),true);
 assert.equal(activities.matches('one',{text:'礼物条件',timestamp:start}),false);
 assert.deepEqual(decodeLottery(item,{roomId:'other',serverTime:start}),[]);
 const end={method:'WebcastLotteryDrawResultEventMessage',payload:join(b(1,n(3,roomId)),n(2,123))};
 assert.equal(activities.update('one',decodeLottery(end,{roomId})[0]),true);
 assert.equal(activities.matches('one',{text:'祝主播好运',timestamp:start}),false);
 assert.deepEqual(decodeLottery({method:'WebcastLotteryEventNewMessage',payload:Buffer.from([10,10,1])},{roomId}),[]);
 assert.deepEqual(decodeLottery({method:'WebcastLotteryEventNewMessage',payload:b(1,Buffer.from([255]))},{roomId}),[]);
});

test('nested LotteryInfo comment type works without localized description, gift conditions never become phrases',()=>{
 const payload=join(n(1,123),n(5,roomId),n(12,start/1000),n(13,start/1000+60),n(20,start/1000),
  b(8,join(n(2,3),b(3,'点点关注，左上角福袋抽钻石'))),b(8,join(n(2,4),b(3,'礼物'),b(5,'发送评论'))));
 const decoded=decodeLottery({method:'WebcastLotteryMessage',payload},{roomId,serverTime:start});
 assert.deepEqual(decoded[0].phrases,['点点关注，左上角福袋抽钻石']);
});
test('late packet lottery is processed before chats; exact activity phrases are filtered, ordinary repeats remain',()=>{
 const info=join(n(1,123),n(5,roomId),n(12,start/1000),n(13,start/1000+60),n(20,start/1000),b(8,join(b(3,'祝主播好运'),b(5,'发送弹幕参与福袋'))));
 const frame=decodePushFrame(packet([chat('祝主播好运'),chat('哈哈哈',2n),chat('哈哈哈',3n),message('WebcastLotteryEventNewMessage',b(2,info))]));
 const activities=new LotteryActivities({now:()=>start}),intake=new ChatIntake({now:()=>start,filterLottery:(key,msg)=>activities.matches(key,msg)});intake.start('one',{start});
 for(const message of frame.messages)for(const activity of decodeLottery(message,{roomId,serverTime:frame.serverTime}))activities.update('one',activity);
 for(const message of frame.messages){const dto=decodeChat(message,{roomId,sourceStart:start});if(dto)intake.add('one',dto);}
 const batch=intake.take('one',{force:true});assert.deepEqual(batch.messages.map(msg=>msg.text),['哈哈哈','哈哈哈']);assert.equal(batch.density[0].count,2);batch.release();
 assert.deepEqual(decodeLottery({method:'WebcastGiftMessage',payload:info},{roomId,serverTime:start}),[]);
 assert.deepEqual(decodeLottery({method:'WebcastLotteryEventNewMessage',payload:info},{roomId:'2',serverTime:start}),[]);
});
test('unknown activities, follow/gift conditions and expired phrases do not hide ordinary text',()=>{
 const info=join(n(1,123),n(5,roomId),n(12,start/1000),n(13,start/1000+60),n(20,start/1000),b(8,join(b(3,'关注主播'),b(5,'送礼物参与'))));
 const activities=new LotteryActivities({now:()=>start});for(const activity of decodeLottery({method:'WebcastLotteryMessage',payload:info},{roomId,serverTime:start}))activities.update('one',activity);
 assert.equal(activities.matches('one',{text:'关注主播',timestamp:start}),false);
});
test('malformed varints, oversize frames and compressed bombs are rejected',()=>{
 assert.throws(()=>[...protobufFields(Buffer.from([10,10,1]))],/不完整/);assert.throws(()=>[...protobufFields(Buffer.alloc(12,255))],/整数/);
 assert.throws(()=>decodePushFrame(Buffer.alloc(PROTOCOL_LIMITS.frameBytes+1)),/过大/);
 assert.throws(()=>decodePushFrame(join(b(6,'gzip'),b(8,gzipSync(Buffer.alloc(PROTOCOL_LIMITS.decodedBytes+1))))));
});
test('chat flood does not hide an activity after the cap or prevent ACK',()=>{
 const chats=Array.from({length:20001},(_,i)=>chat('正常',BigInt(i+1)));
 const frame=decodePushFrame(packet([...chats,message('WebcastLotteryMessage',Buffer.from([8,1]))]));
 assert.equal(frame.truncated,true);assert.equal(frame.needAck,true);assert.equal(frame.messages.length,20001);assert.equal(frame.messages.at(-1).method,'WebcastLotteryMessage');
});
