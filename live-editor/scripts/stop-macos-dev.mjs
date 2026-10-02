import fs from 'node:fs/promises';
import path from 'node:path';
const data=await fs.realpath(process.argv[2]);
const endpoint=JSON.parse(await fs.readFile(path.join(data,'desktop-service.json'),'utf8'));
const url=new URL(endpoint.origin);
if(endpoint.dataPath!==data||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid development endpoint');
const headers={'X-Caibo-Instance':endpoint.token,'Content-Type':'application/json'};
const current=await fetch(url.origin+'/internal/desktop',{headers,signal:AbortSignal.timeout(5000)});
const status=await current.json();
if(!current.ok||status.instance!==endpoint.instance||status.dataPath!==data)throw Error('Unverified development service');
if(status.busy)throw Error('开发环境仍有任务，请先在窗口中停止任务后再构建。');
if(process.argv.includes('--check'))process.exit(0);
const result=await fetch(url.origin+'/internal/desktop',{method:'POST',headers,body:JSON.stringify({action:'quit',confirmed:false}),signal:AbortSignal.timeout(5000)});
if(!(await result.json()).quitAccepted)throw Error('Development service refused to quit');
for(let n=0;n<100;n++){try{await fs.access(path.join(data,'desktop-service.json'));}catch{returnExit();}await new Promise(r=>setTimeout(r,100));}
throw Error('Development service has not stopped');
function returnExit(){process.exit(0);}
