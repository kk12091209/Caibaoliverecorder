import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function availableLocalPort(){
  const listener=net.createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}
export async function findOwnedCore({executable,directory}){
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
