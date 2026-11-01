import test from 'node:test';
import assert from 'node:assert/strict';
import {DouyinChatSignals,chatFailure,douyinChatError,safeChatStatus,chatStatusMessage} from '../server/douyin-chat-status.js';

test('first data and comment events remain ordered even when upgrade includes data, and quiet connections are not reported as comments',()=>{
 let now=0;const events=[],signals=new DouyinChatSignals(e=>events.push(e),{now:()=>now});
 signals.begin();now=215;signals.first('first-frame');signals.first('first-comment');signals.first('first-comment');
 assert.deepEqual(events.map(e=>e.status),['connecting']);signals.established();
 assert.deepEqual(events.map(e=>e.status),['connecting','connected','first-frame','first-comment']);assert.equal(events[1].elapsedMs,215);
 signals.begin();signals.established();assert.equal(events.filter(e=>e.status==='first-comment').length,1);signals.first('first-comment');assert.equal(events.at(-1).attempt,2);
});
test('retry retains safe failure phase, numeric HTTP or close code, duration and wait without raw payloads',()=>{
 let now=100;const events=[],signals=new DouyinChatSignals(e=>events.push(e),{now:()=>now});signals.begin();now=350;
 signals.retry(Object.assign(douyinChatError('http','upgrade',403),{message:'Cookie: private-cookie https://private.invalid/?token=private-token',body:'private-body'}),3000);
 assert.deepEqual(events.at(-1),{status:'retry',stage:'upgrade',reason:'http',code:403,elapsedMs:250,retryMs:3000,attempt:1});
 const text=chatStatusMessage('123','retry',events.at(-1)).message;assert.match(text,/WebSocket 握手.*HTTP.*代码 403.*0\.3 秒.*3\.0 秒后重试/);assert.doesNotMatch(JSON.stringify(events),/private/);
 assert.deepEqual(chatFailure(douyinChatError('close','receive',1006)),{reason:'close',stage:'receive',code:1006});
});
test('network, timeout, TLS and worker failures have bounded categories; untrusted strings are discarded',()=>{
 for(const [code,reason]of [['ENOTFOUND','dns'],['EAI_AGAIN','dns'],['ECONNRESET','network'],['ETIMEDOUT','timeout'],['CERT_HAS_EXPIRED','tls']])assert.equal(chatFailure({code,message:'private-secret'}).reason,reason);
 assert.deepEqual(safeChatStatus('retry',{reason:'private-secret',stage:'private-secret',code:'403',elapsedMs:Infinity,retryMs:-1,cookie:'private-secret'}),{status:'retry'});
 assert.equal(safeChatStatus('private-secret'),null);assert.equal(chatStatusMessage('private-secret','retry'),null);
 assert.deepEqual(safeChatStatus('connected',null),{status:'connected'});
 const events=[],signals=new DouyinChatSignals(e=>events.push(e));signals.begin();signals.established();for(let i=0;i<100;i++)signals.first('message-invalid');assert.equal(events.filter(e=>e.status==='message-invalid').length,1);
});
