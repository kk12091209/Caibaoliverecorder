import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DailyDiagnostics} from '../server/diagnostics.js';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {stopChild} from '../server/child-stop.js';
import {availableLocalPort} from '../server/local-endpoint.js';

function packet(action,body){const content=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),b=Buffer.alloc(16+content.length);b.writeUInt32BE(b.length);b.writeUInt16BE(16,4);b.writeUInt16BE(1,6);b.writeUInt32BE(action,8);b.writeUInt32BE(1,12);content.copy(b,16);return b;}
function websocketFrame(body){const header=Buffer.alloc(body.length<126?2:4);header[0]=0x82;if(body.length<126)header[1]=body.length;else{header[1]=126;header.writeUInt16BE(body.length,2);}return Buffer.concat([header,body]);}
async function until(check,message,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(50);}assert.fail(message);}

// Opt-in: runs a real compiled core, local HTTP video and WebSocket provider.
// No user cookie is read. Only the core's anonymous WBI bootstrap uses Bilibili.
test('real core survives rejected auth, missing auth and missing heartbeats while video and XML indexing continue',{
 skip:process.env.CAIBO_CHAT_INTEGRATION!=='1',timeout:180000
},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-chat-recovery-')),directory=path.join(root,'core');await fs.mkdir(directory);
 const log=await DailyDiagnostics.open(path.join(root,'logs'));
 let core,store,ingestor,videoRequests=0,connections=0,danmakuRequests=0,video,firstVideoPath,coreErrors='';const sockets=new Set(),media=new Set(),timers=new Set();
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),send=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:0,data}));};
  if(url.pathname.endsWith('/getInfoByRoom'))return send({room_info:{room_id:25034104,uid:123,live_status:1,title:'connection-fixture',area_id:1,parent_area_id:1},anchor_info:{base_info:{uname:'fixture'}}});
  if(url.pathname.endsWith('/getDanmuInfo')){danmakuRequests++;return send({token:'fixture-protocol-secret',host_list:[{host:'127.0.0.1',ws_port:server.address().port,wss_port:0,port:0}]});}
  if(url.pathname.endsWith('/getRoomPlayInfo'))return send({live_status:1,encrypted:false,playurl_info:{playurl:{stream:[{protocol_name:'http_stream',format:[{format_name:'flv',codec:[{codec_name:'avc',base_url:'/video.flv',current_qn:10000,accept_qn:[10000],url_info:[{host:`http://127.0.0.1:${server.address().port}`,extra:''}]}]}]}]}}});
  if(url.pathname==='/video.flv'){
   videoRequests++;res.writeHead(200,{'Content-Type':'video/x-flv'});
   const child=spawn(process.env.FFMPEG_PATH,['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','10','-c:a','aac','-b:a','32k','-f','flv','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   media.add(child);child.stderr.resume();child.stdout.pipe(res);res.on('close',()=>stopChild(child));child.on('close',()=>media.delete(child));return;
  }
  res.writeHead(404);res.end();
 });
 server.on('upgrade',(req,socket)=>{
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);sockets.add(socket);
  const number=++connections;let pending=Buffer.alloc(0),timer;
  const send=(action,body)=>{if(!socket.destroyed)socket.write(websocketFrame(packet(action,body)));};
  socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);clearInterval(timer);timers.delete(timer);});
  socket.on('data',chunk=>{
   pending=Buffer.concat([pending,chunk]);
   while(pending.length>=2){
    let length=pending[1]&127,offset=2;if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}else if(length===127){socket.destroy();return;}
    const masked=(pending[1]&128)!==0,header=offset+(masked?4:0);if(pending.length<header+length)return;
    const opcode=pending[0]&15,body=Buffer.from(pending.subarray(header,header+length));if(masked)for(let i=0;i<body.length;i++)body[i]^=pending[offset+i%4];pending=pending.subarray(header+length);
    if(opcode===8){socket.destroy();return;}if(opcode!==2||body.length<16)continue;
    const action=body.readUInt32BE(8);
    if(action===7){
     if(number===1)send(8,{code:-101,message:'fixture-response-secret'});
     else if(number>=3){
      send(8,{code:0});
      timer=setInterval(()=>send(5,{cmd:'DANMU_MSG',info:[[0,1,25,16777215,Date.now(),0,0,'',0,1],`fixture-${number}`,[123,'fixture-viewer',0,0],[],[],[],[],0]}),300);timers.add(timer);
     }
    }else if(action===2&&number>=4)send(3,Buffer.alloc(4));
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
  ingestor?.stop();if(core){stopChild(core);if(core.exitCode===null)await Promise.race([once(core,'exit'),delay(5000)]);}
  for(const timer of timers)clearInterval(timer);for(const socket of sockets)socket.destroy();
  for(const child of media)stopChild(child);await delay(150);
  await new Promise(resolve=>server.close(resolve));while(ingestor?.busy)await delay(20);store?.close();await log.close();await fs.rm(root,{recursive:true,force:true});
 });
 const override=value=>({HasValue:true,Value:value});
 await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({version:3,global:{LiveApiHost:override(`http://127.0.0.1:${server.address().port}`),DanmakuTransport:override(2),TimingDanmakuRetry:override(50),RecordDanmaku:override(true),RecordDanmakuFlushInterval:override(0),CuttingMode:override(0)},rooms:[{RoomId:override(25034104),AutoRecord:override(true)}]}));
 const port=await availableLocalPort(),secret=randomBytes(24).toString('hex');
 core=spawn(process.env.RECORDER_PATH,['run','--http-bind',`http://127.0.0.1:${port}`,'--http-basic-user','fixture','--http-basic-pass',secret,'--enable-file-browser','false',directory],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BREC_SKIP_DISABLE_QUICK_EDIT:'1',BILILIVERECORDER_DISABLE_FILE_LOG:'1',BREC_EPHEMERAL_AUTH:'0'}});
 log.protectSecret(secret);log.attach(core.stdout,'B站核心输出');log.attach(core.stderr,'B站核心错误');
 core.stdout.on('data',bytes=>{if(/WRN|ERR/.test(bytes.toString()))coreErrors=(coreErrors+bytes.toString()).slice(-2500);});
 async function api(route){return fetch(`http://127.0.0.1:${port}/api/${route}`,{headers:{Authorization:'Basic '+Buffer.from('fixture:'+secret).toString('base64')},signal:AbortSignal.timeout(2000)});}
 async function files(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else if(p.endsWith('.flv'))out.push(p);}return out;}
 await until(async()=>{video=(await files(directory))[0];return !!video;},'Local fixture video did not start. '+coreErrors,30000);
 firstVideoPath=video;const firstBytes=(await fs.stat(video)).size;
 store=new Store(path.join(root,'index'));const session=store.createSession({room:25034104});store.addSource(session.id,video);ingestor=new Ingestor(store);ingestor.start();
 await until(()=>connections>=3,'Authentication rejection/timeout did not reconnect',35000);
 await until(()=>store.get('SELECT count(*) AS n FROM danmaku').n>0,'Authenticated comments were not indexed');
 assert.equal(videoRequests,1);assert.equal((await files(directory)).length,1);assert.ok((await fs.stat(video)).size>firstBytes);
 const beforeTimeoutBytes=(await fs.stat(video)).size;
 await until(()=>connections>=4,'Missing heartbeat did not reconnect despite incoming comments',110000);
 await until(()=>store.get("SELECT count(*) AS n FROM danmaku WHERE text='fixture-4'").n>0,'Reconnected comments did not reach preview index');
 assert.ok(danmakuRequests>=4,'Every reconnect must refresh authentication info');
 assert.equal(videoRequests,1,'Chat recovery must not reopen the video stream');assert.deepEqual(await files(directory),[firstVideoPath]);assert.ok((await fs.stat(video)).size>beforeTimeoutBytes);
 const response=await fetch(`http://127.0.0.1:${port}/api/room/25034104/stop`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from('fixture:'+secret).toString('base64'),'Content-Type':'application/json'},body:'{}'});assert.ok(response.ok);
 await delay(300);await log.pending;const xml=await fs.readFile(video.replace(/\.flv$/i,'.xml'),'utf8');assert.match(xml,/<\/i>\s*$/);assert.match(xml,/fixture-3/);assert.match(xml,/fixture-4/);
 const logs=await fs.readdir(log.directory);const text=(await Promise.all(logs.filter(x=>x.endsWith('.txt')).map(x=>fs.readFile(path.join(log.directory,x),'utf8')))).join('\n');
 for(const expected of ['弹幕认证被拒绝','代码 -101','弹幕认证等待超时','弹幕心跳回应超时','已收到首条普通弹幕'])assert.ok(text.includes(expected),expected);
 for(const sensitive of ['fixture-protocol-secret','fixture-response-secret','fixture-viewer'])assert.ok(!text.includes(sensitive));
 const count=store.get('SELECT count(*) AS n FROM danmaku').n;
 const result={platform:process.platform,connections,danmakuRequests,videoRequests,videoFiles:1,xmlComments:(xml.match(/<d /g)||[]).length,indexedComments:count,authenticationRejection:'passed',authenticationTimeout:'passed',heartbeatRecovery:'passed',continuousVideo:'passed',sanitizedLogs:'passed'};
 console.log(JSON.stringify(result));if(process.env.CAIBO_CHAT_REPORT)await fs.writeFile(process.env.CAIBO_CHAT_REPORT,JSON.stringify(result,null,2)+'\n');
});
