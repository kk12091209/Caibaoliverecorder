import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {browserDestination,createBrowserEgress} from '../../server/downloader/infrastructure/browser-egress.mjs'
test('browser egress pins approved DNS answers and rejects mixed/private addresses, ports and encodings',async()=>{
 const resolve=async()=>[{address:'1.1.1.1',family:4}]
 assert.deepEqual(await browserDestination('www.douyin.com:443',resolve),{host:'1.1.1.1',family:4,port:443})
 for(const value of ['localhost:443','127.0.0.1:443','www.douyin.com:80','www.douyin.com@evil.com:443','evil.com:443','www.douyin.com:443/path','[::1]:443'])await assert.rejects(browserDestination(value,resolve))
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1'])await assert.rejects(browserDestination('www.xiaohongshu.com:443',async()=>[{address:'1.1.1.1',family:4},{address,family:4}]))
 await assert.rejects(browserDestination('www.douyin.com:443',async()=>[{address:'::1',family:6}]))
})
test('CONNECT requires private proxy credential and refuses unapproved targets without dialing',async t=>{
 let dials=0;const egress=await createBrowserEgress({resolve:async()=>[{address:'127.0.0.1',family:4}],connect(){dials++;throw Error('must not dial')}});t.after(()=>egress.close())
 const send=(target,auth='')=>new Promise((resolve,reject)=>{const c=net.connect({host:'127.0.0.1',port:Number(new URL(egress.proxy.server).port)},()=>c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));c.on('error',reject);c.once('data',data=>{c.destroy();resolve(data.toString())})})
 assert.match(await send('www.douyin.com:443'),/407/)
 const auth='Proxy-Authorization: Basic '+Buffer.from(egress.proxy.username+':'+egress.proxy.password).toString('base64')+'\r\n'
 assert.match(await send('www.douyin.com:443',auth),/403/);assert.match(await send('evil.example:443',auth),/403/);assert.equal(dials,0)
})
