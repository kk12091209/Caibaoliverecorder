import {timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function uiAuthorized(req,runtime){
  if(runtime.authorized(req))return true;
  const expected=Buffer.from('Basic '+Buffer.from('caibao:'+runtime.uiToken).toString('base64'));
  const actual=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export function requireLocalAccess(req,res,runtime){
  if(uiAuthorized(req,runtime))return true;
  res.writeHead(401,{'WWW-Authenticate':`Basic realm="Caibao-${runtime.instance}", charset="UTF-8"`,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({error:'请从桌面软件打开；本地开发浏览器请使用私有实例凭据登录。'}));return false;
}
export async function protectDataDirectory(root){
  if(process.platform!=='win32'){await fs.chmod(root,0o700);return;}
  // Protect the parent before writing any descriptor. Newly created files
  // inherit only the current Windows account and SYSTEM, including on portable installs.
  // Call .NET directly: inherited PowerShell 7 module paths can prevent the
  // Windows PowerShell Security module (Set-Acl) from loading.
  const script="$ErrorActionPreference='Stop'; $p=$env:CAIBAO_PRIVATE_ROOT; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($id in @($sid,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule)}; [System.IO.Directory]::SetAccessControl($p,$acl)";
  try{await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CAIBAO_PRIVATE_ROOT:root},timeout:10000,windowsHide:true,maxBuffer:32768});}
  catch{throw Error('无法保护本地数据目录的访问权限，请将软件移至当前用户的目录后重试。');}
}
