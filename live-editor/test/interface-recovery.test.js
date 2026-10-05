import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { recoverInterface } from '../server/interface-recovery.js';

test('界面恢复等待旧窗口退出，期间保持后台连接且不停止录像', async t => {
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-interface-recovery-'));
  const requests=[];
  const server=http.createServer(async (req,res)=>{
    let bytes='';for await(const chunk of req)bytes+=chunk;
    requests.push({token:req.headers['x-caibo-instance'],...JSON.parse(bytes)});
    res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(data,{recursive:true,force:true});});
  await fs.writeFile(path.join(data,'recording.flv'),'retain-original');
  await fs.writeFile(path.join(data,'desktop-service.json'),JSON.stringify({protocol:1,dataPath:data,origin:`http://127.0.0.1:${server.address().port}`,token:'a'.repeat(64)}));
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(),200)'],{stdio:'ignore'});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let launched;
  await recoverInterface({pid:child.pid,target:path.join(data,'菜播.app'),data,attempt:1},{platform:'darwin',keepAliveMs:20,launch:async(file,args)=>{
    assert.notEqual(child.exitCode,null,'必须先释放旧窗口和进程');launched={file,args};
  }});
  assert.equal(launched.file,'/usr/bin/open');
  assert.ok(launched.args.includes('CAIBO_UI_RECOVERY_ATTEMPT=1'));
  assert.ok(launched.args.includes('CAIBO_DATA_ROOT='+data));
  assert.ok(requests.length>=1);
  assert.ok(requests.every(r=>r.action==='heartbeat'&&r.pid===process.pid&&r.token==='a'.repeat(64)));
  assert.equal(await fs.readFile(path.join(data,'recording.flv'),'utf8'),'retain-original');
});

test('旧界面不能退出时停止恢复，不启动重复窗口',async()=>{
  let launched=false;
  await assert.rejects(recoverInterface({pid:123,target:'/tmp/菜播.app',data:'/tmp/absent-caibo-data',attempt:2},
    {platform:'darwin',timeoutMs:5,keepAliveMs:0,isAlive:()=>true,pause:()=>new Promise(r=>setTimeout(r,10)),launch:async()=>{launched=true;}}),/旧界面尚未退出/);
  assert.equal(launched,false);
});

test('Windows 恢复只启动同一个应用并继承恢复次数',async()=>{
  let launch;
  await recoverInterface({pid:123,target:path.resolve('录播机.exe'),data:path.resolve('absent-test-data'),attempt:3},
    {platform:'win32',isAlive:()=>false,keepAliveMs:0,launch:async(file,args,env)=>{launch={file,args,env};}});
  assert.equal(launch.file,path.resolve('录播机.exe'));assert.deepEqual(launch.args,[]);
  assert.equal(launch.env.CAIBO_UI_RECOVERY_ATTEMPT,'3');
  await assert.rejects(recoverInterface({pid:123,target:'/tmp/app.app',data:'/tmp/test',attempt:4}),/恢复请求无效/);
});
