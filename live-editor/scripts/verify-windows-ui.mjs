// Exercise the actual Windows desktop executable and WebView2, not a standalone browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
assert.equal(process.platform,'win32');
const {chromium}=await import(pathToFileURL(path.resolve(process.env.CAIBO_PLAYWRIGHT_MODULE)));
const app=path.join(root,'程序组件','live-editor'),data=path.join(app,'data'),exe=path.join(root,'录播机.exe');
await fs.mkdir(out,{recursive:true});
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const debugPort=listener.address().port;await new Promise(r=>listener.close(r));
let browser,child,endpoint;const events=[],failures=[];
const record=(type,detail={})=>events.push({at:new Date().toISOString(),type,...detail});
const safeUrl=value=>{try{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'?u.origin+u.pathname:u.protocol;}catch{return 'invalid';}};
const readEndpoint=async()=>{try{return JSON.parse(await fs.readFile(path.join(data,'desktop-service.json'),'utf8'));}catch{return null;}};
const request=async(action)=>{
 endpoint=await readEndpoint();if(!endpoint)return;
 try{return await fetch(endpoint.origin+'/internal/desktop',{method:'POST',headers:{'X-Caibo-Instance':endpoint.token,'Content-Type':'application/json'},body:JSON.stringify(action),signal:AbortSignal.timeout(3000)});}catch{}
};
try{
 child=spawn(exe,[],{cwd:root,stdio:'ignore',env:{...process.env,NO_RECORDER:'1',EDITOR_DESKTOP_MANAGED:'1',RECORDER_PROJECT_ROOT:root,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`}});
 child.on('exit',(code,signal)=>record('desktop-exit',{code,signal}));
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  try{await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:AbortSignal.timeout(1000)});browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{timeout:5000});break;}catch{await delay(250);}
 }
 endpoint=await readEndpoint();record('backend',{available:!!endpoint});
 assert.ok(browser,'Actual desktop WebView2 did not expose a renderer');
 const context=browser.contexts()[0];let page=context.pages()[0];
 if(!page)page=await context.waitForEvent('page',{timeout:10000});
 page.on('pageerror',e=>failures.push(e.message));
 page.on('console',m=>{if(['error','warning'].includes(m.type()))record('console',{level:m.type(),text:m.text().replace(/https?:\/\/[^\s]+/g,'[URL]')});});
 page.on('response',r=>{if(r.status()>=400)record('http-error',{url:safeUrl(r.url()),status:r.status()});});
 page.on('requestfailed',r=>record('request-failed',{url:safeUrl(r.url()),error:r.failure()?.errorText}));
 page.on('framenavigated',f=>{if(f===page.mainFrame())record('navigation',{url:safeUrl(f.url())});});
 try{
  await page.getByRole('button',{name:'设置',exact:true}).waitFor({state:'visible',timeout:35000});
  if(!await page.getByLabel('主播直播间或抖音名片分享内容').isVisible())await page.getByRole('button',{name:'切换素材栏',exact:true}).click();
  await page.getByLabel('主播直播间或抖音名片分享内容').waitFor({state:'visible',timeout:5000});
  const status=await page.evaluate(async()=>({status:(await fetch('/api/state')).status,text:document.body.innerText.slice(0,800)}));
  assert.equal(status.status,200);assert.match(status.text,/监控主播/);assert.deepEqual(failures,[]);
  record('interface-ready',{url:safeUrl(page.url()),title:await page.title(),apiStatus:status.status});
  await page.screenshot({path:path.join(out,'loaded.png')});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'调整录制样式',exact:true}).waitFor({timeout:5000});
  record('settings-open');await page.screenshot({path:path.join(out,'settings.png')});
  await page.reload();
  await page.getByRole('button',{name:'设置',exact:true}).waitFor({state:'visible',timeout:10000});
  assert.equal(await page.evaluate(async()=>(await fetch('/api/state')).status),200);
  record('authenticated-reload');
 }finally{
  try{await page.screenshot({path:path.join(out,'final-page.png'),timeout:5000});}catch{}
  try{await fs.writeFile(path.join(out,'page.txt'),(await page.locator('body').innerText({timeout:3000})).slice(0,16000));}catch{}
 }
 assert.equal((await fetch(endpoint.origin+'/api/state')).status,401,'Private API must still reject unauthenticated access');
 await fs.writeFile(path.join(out,'verification.json'),JSON.stringify({passed:true,actualDesktop:true,webview2:true,meaningfulUI:true,settingsInteraction:true,authenticatedReload:true,anonymousDenied:true,errors:failures},null,2));
 console.log('Actual Windows desktop renders the UI, opens settings and preserves local authentication.');
}catch(error){
 record('failure',{message:error.message});
 await fs.writeFile(path.join(out,'verification.json'),JSON.stringify({passed:false,message:error.message,errors:failures},null,2));
 throw error;
}finally{
 await request({action:'quit',confirmed:true});
 for(let n=0;child&&child.exitCode===null&&n<50;n++)await delay(100);
 // Stop only the executable in this disposable fixture; never a name-wide kill.
 try{await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -in @($env:CAIBO_QA_EXE,$env:CAIBO_QA_NODE)} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}"],{env:{...process.env,CAIBO_QA_EXE:exe,CAIBO_QA_NODE:path.join(root,'程序组件','runtime','node','node.exe')},timeout:10000});}catch{}
 try{await browser?.close();}catch{}
 try{const logs=await fs.readdir(path.join(data,'logs'));for(const name of logs)if(/\.txt$/.test(name))await fs.copyFile(path.join(data,'logs',name),path.join(out,name));}catch{}
 await fs.writeFile(path.join(out,'events.json'),JSON.stringify(events,null,2));
}
