import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createDownloaderApi } from '../../server/downloader/api.mjs';
import { DownloadAccess } from '../../server/downloader/http/access.mjs';

class Response extends Writable {
  constructor(){super();this.headers={};this.statusCode=200;this.chunks=[];this.headersSent=false;}
  _write(chunk,_encoding,callback){this.chunks.push(chunk);callback();}
  setHeader(key,value){this.headers[key.toLowerCase()]=value;}
  writeHead(status,headers){this.statusCode=status;for(const[key,value]of Object.entries(headers))this.setHeader(key,value);this.headersSent=true;return this;}
  flushHeaders(){this.headersSent=true;}
  value(){return JSON.parse(Buffer.concat(this.chunks).toString());}
}
async function call(api,path,{method='GET',headers={},body}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url='/api/downloader/'+path;req.method=method;req.headers={host:'caibao.media',...headers};req.socket={remoteAddress:'203.0.113.4'};
  const res=new Response();res.on('error',()=>{});await api.handler(req,res,()=>assert.fail('API route should be handled'));return {status:res.statusCode,headers:res.headers,error:res.errored,body:res.headers['content-type']?.includes('application/json')?res.value():Buffer.concat(res.chunks)};
}
const resolver={async resolve(){return {platform:'douyin',kind:'images',id:'123',title:'测试图片',author:'作者',url:'https://www.douyin.com/note/123',cover:'',avatar:'',assets:[{index:1,type:'image',title:'图片 1',width:100,height:100,urls:[],thumbnail:'https://p11-sign.douyinpic.com/fixture.webp'}]};}};
test('public download API scopes works, jobs, media and cancellation to the visitor cookie',async()=>{
  const api=createDownloaderApi({resolver,publicOrigins:['https://caibao.media']});
  try{
    const a=await call(api,'config'),b=await call(api,'config');
    assert.equal(a.status,200);assert.notEqual(a.body.token,b.body.token);
    assert.match(a.headers['set-cookie'],/Secure; HttpOnly; SameSite=Strict/);
    const ownerA={cookie:a.headers['set-cookie'].split(';')[0],'x-downloader-token':a.body.token,origin:'https://caibao.media'};
    const ownerB={cookie:b.headers['set-cookie'].split(';')[0],'x-downloader-token':b.body.token,origin:'https://caibao.media'};
    assert.equal((await call(api,'resolve',{method:'POST',headers:{'x-downloader-token':a.body.token},body:{text:'x'}})).status,401);
    assert.equal((await call(api,'resolve',{method:'POST',headers:{...ownerA,'x-downloader-token':b.body.token},body:{text:'x'}})).status,403);
    const result=await call(api,'resolve',{method:'POST',headers:ownerA,body:{text:'x'}});assert.equal(result.status,200);
    assert.equal((await call(api,`media/${result.body.sessionId}/1`,{headers:ownerB})).status,404);
    assert.equal((await call(api,'jobs',{method:'POST',headers:ownerB,body:{sessionId:result.body.sessionId,indices:[1]}})).status,400);
    const job=await call(api,'jobs',{method:'POST',headers:ownerA,body:{sessionId:result.body.sessionId,indices:[1]}});assert.equal(job.status,201);
    assert.equal((await call(api,`jobs/${job.body.id}`,{headers:ownerB})).status,404);
    assert.equal((await call(api,`jobs/${job.body.id}/cancel`,{method:'POST',headers:ownerB,body:{}})).status,404);
    assert.equal((await call(api,`jobs/${job.body.id}`,{headers:ownerA})).status,200);
  }finally{await api.close();}
});
test('public API rejects a different host or origin and supports internal health checks',async()=>{
  const api=createDownloaderApi({resolver,publicOrigins:['https://caibao.media']});
  try{
    assert.equal((await call(api,'config',{headers:{host:'evil.example'}})).status,403);
    assert.equal((await call(api,'config',{headers:{origin:'https://evil.example'}})).status,403);
    assert.equal((await call(api,'health',{headers:{host:'127.0.0.1:8790'}})).status,200);
    assert.equal((await call(api,'config',{headers:{host:'127.0.0.1:8790'}})).status,403);
  }finally{await api.close();}
});
test('public visit expiry and request rate limits are enforced without affecting local mode',()=>{
  let now=1000;const access=new DownloadAccess({publicOrigins:['https://caibao.media'],now:()=>now});
  const req={method:'GET',headers:{host:'caibao.media'},socket:{remoteAddress:'203.0.113.4'}},res=new Response();
  const visitor=access.authorize(req,res,{config:true});access.consume(visitor,'test',1,1000);assert.throws(()=>access.consume(visitor,'test',1,1000),error=>error.status===429);
  now+=1001;assert.doesNotThrow(()=>access.consume(visitor,'test',1,1000));
  req.headers.cookie=res.headers['set-cookie'].split(';')[0];now+=7200001;assert.throws(()=>access.authorize(req,res),error=>error.status===401);
  const local=new DownloadAccess();assert.doesNotThrow(()=>local.authorize({method:'GET',headers:{host:'127.0.0.1:17970'}},res,{config:true}));
  assert.throws(()=>new DownloadAccess({publicOrigins:['http://caibao.media']}));
});

test('native browser download waits for preparation, supports ranges and HEAD, and authorizes the owner before waiting',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),bytes=Buffer.from('native-browser-jpg-bytes');
  const images={download:async(_urls,{onProgress})=>{await gate;onProgress(bytes.length,bytes.length);return {data:bytes,extension:'jpg',type:'image/jpeg',width:100,height:100};}};
  const api=createDownloaderApi({resolver,publicOrigins:['https://caibao.media'],jobOptions:{images,fileServer:true}});
  try{
    const a=await call(api,'config'),b=await call(api,'config');
    const owner={cookie:a.headers['set-cookie'].split(';')[0],'x-downloader-token':a.body.token,origin:'https://caibao.media'},other={cookie:b.headers['set-cookie'].split(';')[0]};
    const result=await call(api,'resolve',{method:'POST',headers:owner,body:{text:'x'}});
    const created=await call(api,'jobs',{method:'POST',headers:owner,body:{sessionId:result.body.sessionId,indices:[1]}}),native=created.body.downloadUrl.replace('/api/downloader/','');
    assert.match(native,/\/download$/);assert.equal((await call(api,native,{headers:other})).status,404);
    let delivered=false;const download=call(api,native,{headers:owner}).then(value=>{delivered=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(delivered,false);release();
    const file=await download;assert.equal(file.status,200);assert.deepEqual(file.body,bytes);assert.match(file.headers['content-disposition'],/^attachment;.*filename\*=UTF-8''/);assert.equal(file.headers['content-type'],'image/jpeg');
    const head=await call(api,native,{method:'HEAD',headers:owner});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],bytes.length);
    const range=await call(api,native,{headers:{...owner,range:'bytes=3-7'}});assert.equal(range.status,206);assert.deepEqual(range.body,bytes.subarray(3,8));
    assert.equal((await call(api,native,{headers:{...owner,range:'bytes=1000-'}})).status,416);
    const authorize=uri=>call(api,'authorize-file',{headers:{...owner,'x-forwarded-uri':uri,'x-forwarded-method':'GET','x-caibao-file':'/etc/passwd'}});
    const auth=await authorize(created.body.downloadUrl);assert.equal(auth.status,204);assert.match(auth.headers['x-caibao-file'],/^\/caibao-downloader-[\w-]+\/[a-f0-9]{36}\/1.jpg$/);assert.equal(auth.headers['x-caibao-type'],'image/jpeg');
    assert.equal((await call(api,'authorize-file',{headers:{...other,'x-forwarded-uri':created.body.downloadUrl,'x-forwarded-method':'HEAD'}})).status,404);
    assert.equal((await authorize('/api/downloader/jobs/../../etc/passwd')).status,404);
    const done=await call(api,`jobs/${created.body.id}`,{headers:owner});
    const inline=await authorize(done.body.files[0].previewUrl);assert.match(inline.headers['x-caibao-disposition'],/^inline;/);
  }finally{release();await api.close();}
});

test('native browser download returns a preparation error instead of hanging when conversion fails',async()=>{
  const api=createDownloaderApi({resolver,publicOrigins:['https://caibao.media'],jobOptions:{images:{download:async()=>{throw new Error('图片已失效');}}}});
  try{
    const a=await call(api,'config'),owner={cookie:a.headers['set-cookie'].split(';')[0],'x-downloader-token':a.body.token};
    const result=await call(api,'resolve',{method:'POST',headers:owner,body:{text:'x'}}),created=await call(api,'jobs',{method:'POST',headers:owner,body:{sessionId:result.body.sessionId,indices:[1]}});
    const response=await call(api,created.body.downloadUrl.replace('/api/downloader/',''),{headers:owner});assert.equal(response.status,409);assert.equal(response.body.error,'图片已失效');
  }finally{await api.close();}
});

test('stream downloads check visitor ownership before waiting and propagate source failure',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const videoResolver={resolve:async()=>({platform:'bilibili',kind:'video',id:'BVtest',url:'https://www.bilibili.com/',title:'视频',assets:[{index:1,type:'video'}]}),bilibiliStreams:async()=>{await gate;throw new Error('视频源不可用');}};
  const api=createDownloaderApi({resolver:videoResolver,publicOrigins:['https://caibao.media']});
  try{
    const a=await call(api,'config'),b=await call(api,'config'),owner={cookie:a.headers['set-cookie'].split(';')[0],'x-downloader-token':a.body.token},other={cookie:b.headers['set-cookie'].split(';')[0]};
    const session=await call(api,'resolve',{method:'POST',headers:owner,body:{text:'x'}});
    const job=await call(api,'jobs',{method:'POST',headers:owner,body:{sessionId:session.body.sessionId,indices:[1],delivery:'stream'}}),url=job.body.downloadUrl.replace('/api/downloader/','');
    assert.match(url,/\/stream$/);assert.equal((await call(api,url,{headers:other})).status,404);assert.equal((await call(api,url)).status,401);
    const waiting=call(api,url,{headers:owner});release();const failed=await waiting;assert.equal(failed.status,200);assert.match(failed.error.message,/视频源不可用/);assert.equal(failed.body.length,0);
  }finally{release();await api.close();}
});

test('album image jobs keep individual JPG files and do not package them into ZIP',async()=>{
  const pictureResolver={resolve:async()=>{const value=await resolver.resolve();return {...value,assets:[...value.assets,{...value.assets[0],index:2}]};}};
  const api=createDownloaderApi({resolver:pictureResolver,publicOrigins:['https://caibao.media'],jobOptions:{images:{download:async(_urls,{onProgress})=>{const data=Buffer.from('jpg');onProgress(data.length,data.length);return {data,extension:'jpg',type:'image/jpeg',width:10,height:10};}}}});
  try{
    const a=await call(api,'config'),owner={cookie:a.headers['set-cookie'].split(';')[0],'x-downloader-token':a.body.token};
    const session=await call(api,'resolve',{method:'POST',headers:owner,body:{text:'x'}}),job=await call(api,'jobs',{method:'POST',headers:owner,body:{sessionId:session.body.sessionId,indices:[1,2],delivery:'album'}});
    await call(api,job.body.downloadUrl.replace('/api/downloader/',''),{headers:owner});
    const done=await call(api,`jobs/${job.body.id}`,{headers:owner});assert.equal(done.body.status,'done');assert.equal(done.body.archive,null);assert.equal(done.body.files.length,2);assert.ok(done.body.files.every(file=>file.type==='image/jpeg'&&file.name.endsWith('.jpg')));
  }finally{await api.close();}
});

test('live gallery responses expose the full photo for preview while keeping motion sources on the server',async()=>{
  const photo='https://p11-sign.douyinpic.com/original.jpg',thumbnail='https://p11-sign.douyinpic.com/thumbnail.jpg';
  const api=createDownloaderApi({resolver:{resolve:async()=>({...await resolver.resolve(),assets:[{index:1,type:'livePhoto',title:'实况 1',width:2160,height:2880,motionWidth:720,motionHeight:960,duration:2.83,thumbnail,photoUrls:[photo],urls:['https://v26-web.douyinvod.com/motion.mp4']}]})}});
  try{
    const config=await call(api,'config',{headers:{host:'127.0.0.1:17970'}});
    const result=await call(api,'resolve',{method:'POST',headers:{host:'127.0.0.1:17970','x-downloader-token':config.body.token},body:{text:'sample'}});
    assert.equal(result.status,200);const asset=result.body.assets[0];
    assert.equal(asset.type,'livePhoto');assert.equal(asset.duration,2.83);assert.equal(asset.directPreview,photo);assert.equal(asset.directThumbnail,thumbnail);
    assert.equal(asset.photoUrls,undefined);assert.equal(asset.urls,undefined);assert.match(asset.preview,/size=full$/);
  }finally{await api.close();}
});
