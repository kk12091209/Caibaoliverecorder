import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(mac=true){
  const sent=[],listeners=new Map(),timers=new Map();let count=0;
  const window={addEventListener:(event,fn)=>listeners.set(event,fn)};
  if(mac)window.webkit={messageHandlers:{caibo:{postMessage:message=>sent.push(message)}}};
  const context=vm.createContext({window,Map,Error,Promise,setTimeout:fn=>{timers.set(++count,fn);return count;},clearTimeout:id=>timers.delete(id)});
  const source=await fs.readFile(new URL('../src/desktop.js',import.meta.url),'utf8');
  vm.runInContext(source.replaceAll('export ','')+'\nthis.power={getPowerStatus,openPowerSettings,isMacDesktop};',context);
  return {api:context.power,sent,timers,reply:data=>listeners.get('caibo-native')({detail:data})};
}
test('休眠桥接只发送固定动作，用对应回复更新状态，打开设置不伪造开启结果',async()=>{
  const f=await fixture(),pending=f.api.getPowerStatus();
  assert.equal(f.sent[0].action,'powerStatus');assert.deepEqual(Object.keys(f.sent[0]).sort(),['action','id']);
  f.reply({id:'other',value:{lid:'enabled'}});assert.equal(f.timers.size,1);
  f.reply({id:f.sent[0].id,value:{version:2,systemSleepAC:'disabled',lid:'disabled',protection:'active'}});
  assert.equal((await pending).lid,'disabled');assert.equal(f.timers.size,0);
  const open=f.api.openPowerSettings();assert.equal(f.sent[1].action,'openPowerSettings');
  f.reply({id:f.sent[1].id,value:true});assert.equal(await open,true);
});
test('旧版组件超时可重试，迟到回复不污染新检测，错误原样反馈',async()=>{
  const f=await fixture(),pending=f.api.getPowerStatus();
  [...f.timers.values()][0]();await assert.rejects(pending,/旧版桌面组件/);
  const retry=f.api.getPowerStatus();f.reply({id:f.sent[0].id,value:{lid:'enabled'}});
  f.reply({id:f.sent[1].id,error:'系统拒绝读取'});await assert.rejects(retry,/系统拒绝读取/);
});
test('网页和 Windows 不调用 Mac 休眠接口',async()=>{
  const f=await fixture(false);assert.equal(f.api.isMacDesktop,false);
  await assert.rejects(f.api.getPowerStatus(),/Mac 桌面应用/);assert.equal(f.sent.length,0);
});
