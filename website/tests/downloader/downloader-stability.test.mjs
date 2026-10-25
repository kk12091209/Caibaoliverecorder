import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkPool, SharedWork } from '../../server/downloader/infrastructure/cache.mjs'
import { saveRemote } from '../../server/downloader/infrastructure/network.mjs'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'
import { runMedia } from '../../server/downloader/media/process.mjs'
import { PlatformResolver } from '../../server/downloader/platforms/resolver.mjs'
import sharp from 'sharp'
import { MediaImages } from '../../server/downloader/media/images.mjs'

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async predicate => { for(let n=0;n<200;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5))} assert.fail('timed out') }

test('bounded stage pool rotates owners and removes cancelled queued work before it starts', async () => {
  const pool = new WorkPool(1), blocked = gate(), order = [], cancel = new AbortController()
  const first = pool.run(() => blocked.promise, { owner:'a' })
  const a = pool.run(() => order.push('a'), { owner:'a' })
  const removed = pool.run(() => assert.fail('cancelled work started'), { owner:'c', signal:cancel.signal })
  const rejected = assert.rejects(removed, { name:'AbortError' }); cancel.abort()
  const b = pool.run(() => order.push('b'), { owner:'b' })
  blocked.resolve(); await Promise.all([first,a,b,rejected]); await tick()
  assert.deepEqual(order,['b','a']); assert.equal(pool.running,0); assert.equal(pool.queue.length,0)
})

test('shared producers survive one cancelled subscriber and stop when the last subscriber leaves', async () => {
  const shared = new SharedWork(), block = gate(), a = new AbortController(), b = new AbortController()
  let calls=0, cancelled=false
  const work = signal => { calls++; signal.addEventListener('abort',()=>{cancelled=true;block.resolve()}); return block.promise }
  const first=shared.run('same',work,a.signal),second=shared.run('same',work,b.signal)
  await tick(); const r1=assert.rejects(first);a.abort();await r1;assert.equal(cancelled,false)
  const r2=assert.rejects(second);b.abort();await r2;await shared.close()
  assert.equal(calls,1);assert.equal(cancelled,true);assert.equal(shared.pending.size,0)
  await assert.rejects(shared.run('fail',()=>{throw Error('temporary')}),/temporary/)
  assert.equal(await shared.run('fail',()=>42),42)
})

test('identical pending resolutions share work and shutdown aborts an unfinished resolution without caching it', async () => {
  const resolver=new PlatformResolver(),cancel=new AbortController(),blocked=gate();let calls=0
  resolver.resolveFresh=async(_input,{signal})=>{calls++;await blocked.promise;signal.throwIfAborted();return {id:'same'}}
  const first=resolver.resolve('https://v.douyin.com/same/',{signal:cancel.signal}),second=resolver.resolve('https://v.douyin.com/same/')
  const rejected=assert.rejects(first,{name:'AbortError'});cancel.abort();blocked.resolve();await rejected
  assert.deepEqual(await second,{id:'same'});assert.equal(calls,1)
  resolver.resolveFresh=(_input,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  const unfinished=resolver.resolve('https://v.douyin.com/pending/'),stopped=assert.rejects(unfinished,{name:'AbortError'})
  await tick();await resolver.close();await stopped
  assert.equal(resolver.shared.active.size,0);assert.equal(resolver.cache.values.size,0)
})

test('thumbnail conversion backpressure bounds retained originals and cancellation drains every stage', async () => {
  const input=await sharp({create:{width:80,height:60,channels:3,background:'pink'}}).webp().toBuffer(),blocked=gate(),abort=new AbortController();let reads=0
  const images=new MediaImages({open:async()=>{reads++;return {status:200,headers:{'content-type':'image/webp'},stream:Readable.from([input])}}})
  const run=images.conversions.run.bind(images.conversions)
  images.conversions.run=(work,options)=>run(async()=>{await blocked.promise;return work()},options)
  const results=Promise.allSettled(Array.from({length:50},(_,i)=>images.preview(`https://p11-sign.douyinpic.com/${i}`,{signal:abort.signal,owner:`visitor-${i%5}`})))
  try {
    await until(()=>reads===4&&images.conversions.queue.length===3)
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(reads,4)
    abort.abort();blocked.resolve();assert.ok((await results).every(item=>item.status==='rejected'))
    await images.close();await tick()
    for(const pool of [images.tasks,images.fetches,images.conversions]){assert.equal(pool.running,0);assert.equal(pool.queue.length,0)}
    assert.equal(images.shared.active.size,0)
  }finally{abort.abort();blocked.resolve();await images.close()}
})

test('a transient range failure retries only that validated range and keeps exact media bytes', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-range-recovery-')),data=Buffer.alloc(8*1024**2+3,19),counts=new Map()
  const open=async(url,{headers})=>{
    const key=headers.Range||'full';counts.set(key,(counts.get(key)||0)+1)
    const common={url,headers:{'content-type':'video/mp4','content-length':String(data.length),'accept-ranges':'bytes',etag:'"immutable"'}}
    if(!headers.Range)return {...common,status:200,stream:Readable.from([data])}
    const [,a,b]=/bytes=(\d+)-(\d+)/.exec(headers.Range),start=Number(a),end=Number(b)
    const flaky=start===0&&counts.get(key)===1
    return {...common,status:206,headers:{...common.headers,'content-range':`bytes ${start}-${end}/${data.length}`},stream:flaky?Readable.from((async function*(){yield data.subarray(start,start+100);throw Error('connection reset')})()):Readable.from([data.subarray(start,end+1)])}
  }
  try {
    const result=await saveRemote(['https://a.bilivideo.com/test'],path.join(dir,'media'),{open,retryDelayMs:1})
    assert.equal(result.parts,3);assert.deepEqual(await readFile(path.join(dir,'media')),data)
    assert.equal(counts.get('full'),1);assert.deepEqual([...counts.values()].sort(),[1,1,1,2])
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('changed validator discards all partial ranges instead of mixing versions', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'caibao-range-version-')),old=Buffer.alloc(8*1024**2,1),fresh=Buffer.alloc(old.length,2);let full=0
  const open=async(url,{headers})=>{
    if(!headers.Range){full++;return {url,status:200,headers:{'content-type':'video/mp4','content-length':String(old.length),'accept-ranges':'bytes',etag:full===1?'"old"':'"new"'},stream:Readable.from([full===1?old:fresh])}}
    const [,a,b]=/bytes=(\d+)-(\d+)/.exec(headers.Range)
    return {url,status:206,headers:{etag:'"new"','content-range':`bytes ${a}-${b}/${old.length}`},stream:Readable.from([fresh.subarray(+a,+b+1)])}
  }
  try {const result=await saveRemote(['https://a.bilivideo.com/test'],path.join(dir,'media'),{open,retryDelayMs:1});assert.equal(result.parts,1);assert.equal(full,2);assert.deepEqual(await readFile(path.join(dir,'media')),fresh)}
  finally {await rm(dir,{recursive:true,force:true})}
})

test('two long video resolutions do not block a photo, and completed job reuse stays within its owner', async () => {
  const waiting=gate(),images={download:async(_urls,{onProgress})=>{onProgress(3,3);return {data:Buffer.from('jpg'),extension:'jpg',type:'image/jpeg'}}}
  const resolver={bilibiliStreams:async(_result,_asset,signal)=>{await waiting.promise;signal.throwIfAborted();throw Error('test finished')}}
  const jobs=new DownloadJobs(resolver,{images})
  const video={platform:'bilibili',kind:'video',id:'v',title:'long',assets:[{index:1,type:'video'}]}
  const photos={platform:'douyin',kind:'images',id:'p',title:'small',assets:[{index:1,type:'image',urls:['https://p.douyinpic.com/p']}]}
  try {
    const a=jobs.create({owner:'a',result:video},[1]),b=jobs.create({owner:'b',result:video},[1])
    const photo=jobs.create({owner:'c',result:photos},[1]),task=jobs.jobs.get(photo.id)
    await jobs.wait(task);assert.equal(task.status,'done');assert.equal(jobs.jobs.get(a.id).status,'running');assert.equal(jobs.jobs.get(b.id).status,'running')
    assert.equal(jobs.create({owner:'c',result:photos},[1]).id,photo.id)
    assert.notEqual(jobs.create({owner:'d',result:photos},[1]).id,photo.id)
    assert.ok(task.timings.snapshot().stages.images.count>0)
    jobs.cancel(a.id);jobs.cancel(b.id);waiting.resolve()
  } finally {waiting.resolve();await jobs.close()}
})

test('completed native attachments expose their immutable download URL when reused', async () => {
  const jobs=new DownloadJobs({}, {images:{download:async(_urls,{onProgress})=>{onProgress(3,3);return {data:Buffer.from('jpg'),extension:'jpg',type:'image/jpeg'}}}})
  const result={kind:'images',title:'archive',assets:[1,2].map(index=>({index,type:'image',urls:[String(index)]}))},session={owner:'owner',result}
  try {
    const created=jobs.create(session,[1,2],'stream');assert.match(created.downloadUrl,/\/stream$/)
    await jobs.wait(jobs.jobs.get(created.id));assert.equal(jobs.jobs.get(created.id).status,'done',jobs.jobs.get(created.id).error)
    const reused=jobs.create(session,[1,2],'stream');assert.equal(reused.id,created.id);assert.match(reused.downloadUrl,/\/download$/)
  } finally {await jobs.close()}
})

test('albums expose an ordered ready prefix and keep completed files after a later failure', async () => {
  const fail=gate(),jobs=new DownloadJobs({}, {images:{download:async(urls,{onProgress})=>{
    if(urls[0]==='2'){await fail.promise;throw Error('second unavailable')}
    onProgress(3,3);return {data:Buffer.from('jpg'),extension:'jpg',type:'image/jpeg'}
  }}})
  try {
    const created=jobs.create({owner:'owner',result:{kind:'images',title:'album',assets:[1,2,3].map(index=>({index,type:'image',urls:[String(index)]}))}},[1,2,3],'album'),job=jobs.jobs.get(created.id)
    await until(()=>job.current===2)
    assert.deepEqual(jobs.public(job).files.map(file=>file.index),[1]);assert.equal(job.status,'running')
    fail.resolve();await jobs.wait(job);assert.equal(job.status,'failed')
    assert.deepEqual(jobs.public(job).files.map(file=>file.index),[1,3])
    for(const file of job.files)assert.equal((await readFile(file.path)).toString(),'jpg')
  } finally {fail.resolve();await jobs.close()}
})

test('stalled and cancelled child processes settle after exit and leave subsequent work usable', async () => {
  const args=['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)']
  await assert.rejects(runMedia(process.execPath,args,undefined,{idleMs:80,killMs:30}),/没有进展/)
  const abort=new AbortController(),task=runMedia(process.execPath,args,abort.signal,{idleMs:1000,killMs:30}),rejected=assert.rejects(task,{name:'AbortError'})
  setTimeout(()=>abort.abort(),80);await rejected
  assert.equal(await runMedia(process.execPath,['-e','process.stdout.write("ok")']), 'ok')
})
