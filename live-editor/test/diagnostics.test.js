import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PassThrough} from 'node:stream';
import {DailyDiagnostics,logDay,safeLog,recordingReason,LOG_MAX_BYTES} from '../server/diagnostics.js';
import {directoryToOpen} from '../server/directories.js';
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'daily-log-'));let at=Date.parse('2026-10-06T09:00:00+08:00');
  const log=await DailyDiagnostics.open(root,{version:'0.1.8',now:()=>at,...options});
  t.after(async()=>{await log.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,log,set:date=>at=Date.parse(date),advance:ms=>at+=ms,read:day=>fs.readFile(path.join(root,'logs',day+'.txt'),'utf8')};
}
test('day boundaries use Beijing time on every platform',()=>{
  assert.equal(logDay(Date.parse('2026-10-06T15:59:59Z')),'2026-10-06');
  assert.equal(logDay(Date.parse('2026-10-06T16:00:00Z')),'2026-10-07');
});
test('log exists immediately; next use on the eighth finalizes sixth without generating unused seventh',async t=>{
  const f=await fixture(t);await f.log.record('用户操作','停止录制');assert.match(await f.read('2026-10-06'),/停止录制/);
  await f.log.close();f.set('2026-10-08T10:00:00+08:00');
  const next=await DailyDiagnostics.open(f.root,{now:()=>Date.parse('2026-10-08T10:00:00+08:00')});await next.close();
  assert.match(await f.read('2026-10-06'),/下次启动补记/);assert.doesNotMatch(await f.read('2026-10-06'),/未留下正常退出/);
  assert.equal((await fs.readdir(next.directory)).includes('2026-10-07.txt'),false);
});
test('multiple opens append timestamps and cumulative counts to the same day',async t=>{
  const f=await fixture(t);await f.log.record('任务','第一次');await f.log.close();
  const next=await DailyDiagnostics.open(f.root,{now:()=>Date.parse('2026-10-06T21:00:00+08:00')});await next.record('任务','第二次');await next.close();
  const text=await f.read('2026-10-06');assert.match(text,/09:00:00/);assert.match(text,/21:00:00/);assert.match(text,/第一次/);assert.match(text,/第二次/);assert.match(text,/累计事件 4/);
});
test('abrupt stop records only last seen time, and never invents an exact shutdown cause',async t=>{
  const f=await fixture(t);await f.log.tick();
  const next=await DailyDiagnostics.open(f.root,{now:()=>Date.parse('2026-10-08T10:00:00+08:00')});await next.close();f.log.closed=true;
  const text=await f.read('2026-10-06');assert.match(text,/未留下正常退出/);assert.match(text,/最后存活记录/);assert.match(text,/不能据此确定具体原因/);
});
test('a continuously running application rotates across midnight and retains only thirty calendar days',async t=>{
  const f=await fixture(t);
  for(let day=0;day<45;day++){await f.log.record('监控','仍在运行');f.advance(86400000);await f.log.tick();}
  await f.log.close();const files=(await fs.readdir(f.log.directory)).filter(file=>file.endsWith('.txt'));
  assert.equal(files.length,30);assert.match(await f.read('2026-11-20'),/正常退出/);assert.equal(files.includes('2026-10-06.txt'),false);
});
test('repeat storms are coalesced; memory, pending writes and UTF-8 file size remain bounded',async t=>{
  const f=await fixture(t);for(let n=0;n<10000;n++)f.log.record('核心','连接失败',{level:'警告'});
  assert.ok(f.log.queued<=128);await f.log.pending;await f.log.tick();
  const text=await f.read('2026-10-06');assert.ok(text.length<10000);assert.match(text,/已合并/);
  for(let n=0;n<600;n++)await f.log.record('错误',`故障 ${n} `+'中文'.repeat(800),{level:'错误'});
  await f.log.close();const bytes=await fs.readFile(path.join(f.log.directory,'2026-10-06.txt'));
  assert.ok(bytes.length<=LOG_MAX_BYTES);assert.match(bytes.toString('utf8'),/本次关闭汇总/);assert.match(bytes.toString('utf8'),/后台正常退出/);assert.ok(f.log.repeat.size<=256);
});
test('credentials, URLs, user home names and controls are removed from nested error details',()=>{
  const error=new Error('failed https://user:pass@cdn.example/a?token=hidden Authorization: Bearer abc',{cause:Object.assign(new Error('disk /Users/privateperson/Movies/a'),{code:'ENOSPC'})});
  const text=safeLog(error);for(const sensitive of ['user:pass','cdn.example','hidden','abc','privateperson'])assert.equal(text.includes(sensitive),false);
  assert.match(text,/ENOSPC/);assert.match(safeLog('token=abc password=def sessdata=ghi'),/已隐藏/);assert.equal(safeLog('\u0000a\nb').includes('\n'),false);
});
test('an unwritable log disk does not reject recording operations and recovers after permissions return',async t=>{
  let broken=true;
  const io=new Proxy(fs,{get(target,key){if(['writeFile','appendFile'].includes(key))return async(...args)=>{if(broken)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return target[key](...args);};return target[key];}});
  const f=await fixture(t,{io});await assert.doesNotReject(f.log.record('录制','启动'));assert.match(f.log.lastError,/ENOSPC/);
  broken=false;await f.log.tick();await f.log.record('录制','恢复后启动');assert.match(await f.read('2026-10-06'),/恢复后启动/);
});
test('core pipes preserve split UTF-8 warning lines, ignore informational output and cap giant partial lines',async t=>{
  const f=await fixture(t),stream=new PassThrough();f.log.attach(stream,'B站核心');const buffer=Buffer.from('[WRN] 磁盘写入错误 ENOSPC\n[INF] ordinary\n');
  for(const byte of buffer)stream.write(Buffer.from([byte]));stream.write('[ERR] '+ 'x'.repeat(1000000));stream.end('\n');
  await new Promise(resolve=>stream.once('end',resolve));await f.log.pending;
  const text=await f.read('2026-10-06');assert.match(text,/磁盘写入错误 ENOSPC/);assert.doesNotMatch(text,/ordinary/);assert.ok(text.length<10000);
});
test('recording reasons distinguish user intent, core outage, live state and unresolved preparation',()=>{
  assert.match(recordingReason({recordingEnabled:false,streaming:true,error:'timeout'}),/用户未启用/);
  assert.match(recordingReason({platform:'bilibili',autoRecord:true},{biliOnline:false}),/核心未连接/);
  assert.match(recordingReason({platform:'douyin',recordingEnabled:true,streaming:false}),/未检测到开播/);
  assert.match(recordingReason({platform:'douyin',recordingEnabled:true,streaming:true}),/原因暂未确定/);
  assert.match(recordingReason({platform:'douyin',recordingEnabled:true,error:'ENOSPC'}),/ENOSPC/);
  assert.equal(recordingReason({recording:true}),'正在录制');
});
test('desktop opens are counted once per GUI client; recovery helpers are not user opens',async t=>{
  const f=await fixture(t);f.log.desktop('a',1);f.log.desktop('a',1);f.log.desktop('helper',2,'recovery');await f.log.pending;
  assert.equal((await f.read('2026-10-06')).match(/打开应用/g).length,1);
  assert.equal(directoryToOpen({root:f.root,setting:()=>null},{kind:'logs'}),path.join(f.root,'logs'));
});

test('raw known credentials and quoted authentication headers cannot enter the TXT',async t=>{
  const f=await fixture(t);f.log.protectSecret('private-secret-123');await f.log.record('核心','credential private-secret-123');
  await f.log.record('核心','{"Authorization":"Bearer private-auth","Cookie":"private-cookie"}');
  const text=await f.read('2026-10-06');for(const value of ['private-secret-123','private-auth','private-cookie'])assert.equal(text.includes(value),false);
});
test('bounded lifecycle tail retains valid closing records even for maximum-width Unicode',async t=>{
  const f=await fixture(t);for(let n=0;n<200;n++)await f.log.record('桌面','😀'.repeat(1600)+n,{important:true});await f.log.close();
  const bytes=await fs.readFile(path.join(f.log.directory,'2026-10-06.txt'));assert.ok(bytes.length<=LOG_MAX_BYTES);assert.match(bytes.toString('utf8'),/本次关闭汇总/);
});

test('coalesced events retain their identity when one component reports different repeated faults',async t=>{
 const f=await fixture(t);for(let n=0;n<4;n++){await f.log.record('核心','磁盘错误');await f.log.record('核心','网络错误');}await f.log.tick();
 const text=await f.read('2026-10-06');assert.match(text,/磁盘错误（相同记录又出现 3 次/);assert.match(text,/网络错误（相同记录又出现 3 次/);
});
