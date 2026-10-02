import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const execFileAsync=promisify(execFile);

// Darwin ps prints argv separated by spaces. Match the complete launch shape,
// executable and final data directory; never infer ownership from a name/PID.
export function macCorePort(command,{executable,directory}){
  if(!command.startsWith(executable+' ')||!command.endsWith(' '+directory))return null;
  const middle=command.slice(executable.length,command.length-directory.length);
  const match=/^ run --http-bind http:\/\/127\.0\.0\.1:(\d+) --http-basic-user editor --http-basic-pass [a-f0-9]{48} --enable-file-browser false $/.exec(middle);
  return match&&browserAccessiblePort(Number(match[1]))?Number(match[1]):null;
}
async function macOwnedCore(pid,identity){
  try{
    const {stdout:exe}=await execFileAsync('/bin/ps',['-p',String(pid),'-o','comm='],{timeout:5000});
    if(exe.trim()!==identity.executable)return null;
    const {stdout:command}=await execFileAsync('/bin/ps',['-ww','-p',String(pid),'-o','command='],{timeout:5000});
    const port=macCorePort(command.trimEnd(),identity);
    return port?{pid,port,...identity}:null;
  }catch{return null;}
}

// HTTP Fetch/WebView2 blocks these even on loopback. Keep the OS allocation,
// but retry before publishing an inaccessible address.
// https://fetch.spec.whatwg.org/#port-blocking
const blockedPorts=new Set([
  0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,
  389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,
  636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,
  6566,6665,6666,6667,6668,6669,6679,6697,10080,
]);
export const browserAccessiblePort=port=>Number.isInteger(port)&&port>0&&port<65536&&!blockedPorts.has(port);
export async function listenLocal(server,port=0){
  if(port!==0&&!browserAccessiblePort(port))throw new Error('本机服务地址不可访问，请使用自动分配或有效端口。');
  for(let attempt=0;attempt<32;attempt++){
    await new Promise((resolve,reject)=>{
      const ready=()=>{server.off('error',failed);resolve();};
      const failed=error=>{server.off('listening',ready);reject(error);};
      server.once('error',failed);server.once('listening',ready);
      server.listen(port,'127.0.0.1');
    });
    const allocated=server.address().port;
    if(browserAccessiblePort(allocated))return allocated;
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
  throw new Error('暂时无法自动分配可访问的本机地址，请重试。');
}
export async function availableLocalPort(){
  const listener=net.createServer();
  try{return await listenLocal(listener);}
  finally{if(listener.listening)await new Promise(resolve=>listener.close(resolve));}
}
export async function findOwnedCore({executable,directory}){
  if(process.platform==='darwin'){
    try{
      const {stdout}=await execFileAsync('/bin/ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:4*1024*1024});
      const found=[];
      for(const line of stdout.split('\n')){
        const match=/^\s*(\d+)\s+(.+)$/.exec(line);
        if(match?.[2]===executable){const core=await macOwnedCore(Number(match[1]),{executable,directory});if(core)found.push(core);}
      }
      return found.length===1?found[0]:null;
    }catch{return null;}
  }
  if(process.platform!=='win32')return null;
  const script=`$ErrorActionPreference='Stop'; $cores=@(Get-CimInstance Win32_Process -Filter "Name = 'BililiveRecorder.Cli.exe'" | Where-Object {$_.ExecutablePath -eq $env:CAIBO_CORE_EXE -and $_.CommandLine.Trim().TrimEnd([char]34).EndsWith($env:CAIBO_CORE_DIRECTORY,[StringComparison]::OrdinalIgnoreCase)}); if($cores.Count -ne 1){exit 0}; $bind=[regex]::Match($cores[0].CommandLine,'--http-bind\\s+"?http://127\\.0\\.0\\.1:(\\d+)'); if($bind.Success){@{pid=[int]$cores[0].ProcessId;port=[int]$bind.Groups[1].Value}|ConvertTo-Json -Compress}`;
  return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{...process.env,CAIBO_CORE_EXE:executable,CAIBO_CORE_DIRECTORY:directory}},(error,stdout)=>{
    if(error)return resolve(null);try{const value=JSON.parse(stdout);resolve(Number.isInteger(value.pid)&&value.pid>0&&value.port>0&&value.port<65536?{...value,executable,directory}:null);}catch{resolve(null);}
  }));
}
// Stop only the recorded core executable and originals directory. Never kill
// an arbitrary owner of a port or a recycled PID belonging to another app.
export async function stopOwnedCore({pid,executable,directory}){
  if(!Number.isInteger(pid)||pid<=0)return false;
  if(process.platform==='darwin'){
    try{process.kill(pid,0);}catch(error){return error.code==='ESRCH';}
    if(!await macOwnedCore(pid,{executable,directory}))return false;
    try{process.kill(pid,'SIGTERM');}catch(error){return error.code==='ESRCH';}
    for(let attempt=0;attempt<100;attempt++){
      try{process.kill(pid,0);}catch(error){return error.code==='ESRCH';}
      await delay(50);
    }
    return false;
  }
  if(process.platform==='win32'){
    const script=`$ErrorActionPreference='Stop'; $core=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:CAIBO_STOP_PID); if(!$core){exit 0}; if($core.ExecutablePath -ne $env:CAIBO_STOP_EXE -or !$core.CommandLine.Trim().TrimEnd([char]34).EndsWith($env:CAIBO_STOP_DIRECTORY,[StringComparison]::OrdinalIgnoreCase)){exit 2}; $process=[Diagnostics.Process]::GetProcessById([int]$env:CAIBO_STOP_PID); $process.Kill(); if(!$process.WaitForExit(5000)){exit 3}`;
    return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,env:{...process.env,CAIBO_STOP_PID:String(pid),CAIBO_STOP_EXE:executable,CAIBO_STOP_DIRECTORY:directory}},error=>resolve(!error)));
  }
  if(process.platform==='linux'){
    try{
      const [exe,command]=await Promise.all([fs.readlink(`/proc/${pid}/exe`),fs.readFile(`/proc/${pid}/cmdline`,'utf8')]);
      if(path.resolve(exe)!==path.resolve(executable)||!command.split('\0').includes(directory))return false;
      process.kill(pid,'SIGTERM');return true;
    }catch(error){return error.code==='ENOENT'||error.code==='ESRCH';}
  }
  return false;
}
