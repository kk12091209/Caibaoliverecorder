const states=new Set(['connecting','connected','first-frame','first-comment','first-gift','first-write','message-invalid','retry','write-failed','stopped']);
const stages={connect:'连接弹幕线路',upgrade:'WebSocket 握手',receive:'接收数据',send:'发送心跳或确认',decode:'解析弹幕',write:'保存弹幕',worker:'弹幕后台'};
const reasons={http:'HTTP 请求被拒绝',close:'服务端关闭连接',handshake:'握手校验失败',dns:'域名解析失败',timeout:'连接超时','heartbeat-timeout':'接收回应超时',network:'网络连接失败',tls:'安全连接失败',protocol:'数据格式异常',backpressure:'发送通道受阻','worker-exit':'弹幕后台已退出','worker-timeout':'弹幕后台无响应',write:'弹幕写入失败',unknown:'未分类连接错误'};
const integer=(value,max=2147483647)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
export function douyinChatError(reason,stage='connect',code){
  return Object.assign(new Error('抖音弹幕连接异常。'),{chatReason:Object.hasOwn(reasons,reason)?reason:'unknown',chatStage:Object.hasOwn(stages,stage)?stage:'connect',...(integer(code,65535)?{chatCode:code}:{})});
}
export function chatFailure(error){
  if(Object.hasOwn(reasons,error?.chatReason)&&Object.hasOwn(stages,error?.chatStage))return {reason:error.chatReason,stage:error.chatStage,...(integer(error.chatCode,65535)?{code:error.chatCode}:{})};
  const code=error?.code;
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return {reason:'dns',stage:'connect'};
  if(['ETIMEDOUT','ESOCKETTIMEDOUT'].includes(code)||['TimeoutError','AbortError'].includes(error?.name))return {reason:'timeout',stage:'connect'};
  if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return {reason:'tls',stage:'connect'};
  return {reason:['ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH','EPIPE'].includes(code)?'network':'unknown',stage:'connect'};
}
// Only this whitelist crosses the worker boundary and enters diagnostic logs.
export function safeChatStatus(status,detail={}){
  if(!states.has(status))return null;
  if(!detail||typeof detail!=='object'||Array.isArray(detail))detail={};
  const result={status};
  if(Object.hasOwn(stages,detail.stage))result.stage=detail.stage;
  if(Object.hasOwn(reasons,detail.reason))result.reason=detail.reason;
  for(const key of ['code','elapsedMs','retryMs','attempt'])if(integer(detail[key],key==='code'?65535:2147483647))result[key]=detail[key];
  return result;
}
export class DouyinChatSignals {
  constructor(emit,{now=()=>performance.now()}={}){this.emit=emit;this.now=now;this.attempt=0;this.started=now();this.seen=new Set();this.pending=[];this.connected=false;}
  send(status,detail={}){const event=safeChatStatus(status,{attempt:this.attempt,elapsedMs:Math.max(0,Math.round(this.now()-this.started)),...detail});if(event)this.emit(event);}
  begin(){this.started=this.now();this.attempt++;this.seen.clear();this.pending=[];this.connected=false;this.send('connecting',{stage:'connect'});}
  established(){this.connected=true;this.send('connected',{stage:'upgrade'});for(const state of this.pending)this.send(state,{stage:state==='first-frame'?'receive':'decode'});this.pending=[];}
  first(state){if(!['first-frame','first-comment','first-gift','message-invalid'].includes(state)||this.seen.has(state))return;this.seen.add(state);if(this.connected)this.send(state,{stage:state==='first-frame'?'receive':'decode'});else this.pending.push(state);}
  retry(error,retryMs){this.send('retry',{...chatFailure(error),retryMs});this.connected=false;this.pending=[];}
}
export function chatStatusMessage(room,status,detail={}){
  const event=safeChatStatus(status,detail);if(!event||!/^\d{1,20}$/.test(String(room)))return null;
  const labels={connecting:'正在连接弹幕服务器',connected:'连接已建立，等待平台数据','first-frame':'已收到首个有效数据包','first-comment':'已收到首条普通弹幕','first-gift':'已收到首条礼物记录','first-write':'首批弹幕或礼物已写入原始记录','message-invalid':'忽略格式异常的消息',retry:'弹幕连接重试中','write-failed':'弹幕保存失败',stopped:'弹幕采集已停止'};
  const suffix=[event.stage&&`阶段：${stages[event.stage]}`,event.reason&&`原因：${reasons[event.reason]}`,event.code!==undefined&&`代码 ${event.code}`,event.elapsedMs!==undefined&&`本次耗时 ${(event.elapsedMs/1000).toFixed(1)} 秒`,event.retryMs!==undefined&&`${(event.retryMs/1000).toFixed(1)} 秒后重试`].filter(Boolean);
  return {message:`房间 ${room}：${labels[status]}${suffix.length?'；'+suffix.join('；'):''}`,level:['retry','write-failed','message-invalid'].includes(status)?'警告':'信息'};
}
