import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {PlatformCredentials,NativeCookieProtection,normalizePlatformCookie} from '../server/platform-credentials.js';
import {testProtection,biliFixture,biliReplacement,douyinFixture} from './credential-fixtures.js';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'cookie-vault-')),protection=testProtection(),vault=await new PlatformCredentials(root,{protection}).initialize();t.after(async()=>{await vault.close();await fs.rm(root,{recursive:true,force:true});});return {root,protection,vault};}
test('Cookie input accepts a single header value and rejects injection, missing login fields and ambiguous duplicates',()=>{
 assert.equal(normalizePlatformCookie('bilibili','Cookie: '+biliFixture),biliFixture);
 assert.equal(normalizePlatformCookie('douyin',douyinFixture),douyinFixture);
 for(const value of [undefined,null,{},'',biliFixture+'\nX: bad',biliFixture+'\0',biliFixture+'; SESSDATA=other','SESSDATA=x; DedeUserID=no','x'.repeat(32769),'SESSDATA="secret"; DedeUserID=1'])assert.throws(()=>normalizePlatformCookie('bilibili',value));
 assert.throws(()=>normalizePlatformCookie('douyin',biliFixture));assert.throws(()=>normalizePlatformCookie('unknown',biliFixture));
});
test('only ciphertext persists; restart unlocks both platforms; replacement leaves no old file or public value',async t=>{
 const {root,vault,protection}=await fixture(t);await vault.save('bilibili',biliFixture);await vault.save('douyin',douyinFixture);
 const before=await fs.readFile(vault.file('bilibili'));assert.ok(!before.includes(Buffer.from('synthetic')));
 // Windows reports synthetic POSIX mode bits; CurrentUser DPAPI protects the
 // contents there. Unix directory/file permissions remain mandatory below.
 if(process.platform!=='win32'){assert.equal((await fs.stat(vault.directory)).mode&0o777,0o700);assert.equal((await fs.stat(vault.file('bilibili'))).mode&0o777,0o600);}
 await vault.save('bilibili',biliReplacement);assert.equal(vault.get('bilibili'),biliReplacement);assert.notDeepEqual(await fs.readFile(vault.file('bilibili')),before);
 assert.deepEqual((await fs.readdir(vault.directory)).sort(),['bilibili.sealed','douyin.sealed']);
 assert.ok(!JSON.stringify(vault.snapshot()).includes('synthetic'));assert.equal(vault.snapshot().platforms.bilibili.configured,true);
 const reopened=await new PlatformCredentials(root,{protection}).initialize();assert.equal(reopened.get('bilibili'),biliReplacement);assert.equal(reopened.get('douyin'),douyinFixture);await reopened.close();assert.equal(reopened.get('bilibili'),'');
});
test('failed encryption preserves the previous file and runtime value, including serialized concurrent replacements',async t=>{
 const {vault,protection}=await fixture(t);await vault.save('bilibili',biliFixture);const before=await fs.readFile(vault.file('bilibili'));
 protection.fail=true;await assert.rejects(vault.save('bilibili',biliReplacement));assert.equal(vault.get('bilibili'),biliFixture);assert.deepEqual(await fs.readFile(vault.file('bilibili')),before);
 protection.fail=false;await Promise.all([vault.save('bilibili',biliFixture),vault.save('bilibili',biliReplacement)]);assert.equal(vault.get('bilibili'),biliReplacement);
});
test('tampered ciphertext or a swapped platform stays locked and anonymous',async t=>{
 const {root,vault,protection}=await fixture(t);await vault.save('bilibili',biliFixture);await fs.copyFile(vault.file('bilibili'),vault.file('douyin'));
 const bytes=await fs.readFile(vault.file('bilibili'));bytes[15]^=1;await fs.writeFile(vault.file('bilibili'),bytes);
 const reopened=await new PlatformCredentials(root,{protection}).initialize();for(const id of ['bilibili','douyin']){assert.equal(reopened.get(id),'');assert.equal(reopened.snapshot().platforms[id].configured,true);assert.match(reopened.snapshot().platforms[id].error,/未能解锁/);}await reopened.close();
});
test('symlinked private directories and symlinked entries never unlock another file',async t=>{
 const {root,vault,protection}=await fixture(t);const elsewhere=path.join(root,'elsewhere');await fs.mkdir(elsewhere);await fs.symlink(elsewhere,vault.directory);
 const reopened=await new PlatformCredentials(root,{protection}).initialize();assert.match(reopened.snapshot().platforms.bilibili.error,/目录异常/);await assert.rejects(vault.save('bilibili',biliFixture));assert.deepEqual(await fs.readdir(elsewhere),[]);await reopened.close();
 await fs.unlink(vault.directory);await fs.mkdir(vault.directory);await fs.writeFile(path.join(elsewhere,'entry'),'not a credential');await fs.symlink(path.join(elsewhere,'entry'),vault.file('bilibili'));
 const linked=await new PlatformCredentials(root,{protection}).initialize();assert.equal(linked.get('bilibili'),'');assert.match(linked.snapshot().platforms.bilibili.error,/无法读取/);await linked.close();
});
test('native helper receives secrets through stdin only and errors never echo child output',async()=>{
 let request,argumentsSeen,optionsSeen;
 const protection=new NativeCookieProtection({platform:'win32',launch(_exe,args,options){argumentsSeen=args;optionsSeen=options;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};let text='';child.stdin.on('data',chunk=>text+=chunk);child.stdin.on('end',()=>{request=JSON.parse(text);child.stdout.end(JSON.stringify({data:Buffer.from('cipher').toString('base64')}));child.emit('close',0);});return child;}});
 assert.equal((await protection.run('seal','f'.repeat(64),'bilibili',Buffer.from(biliFixture))).toString(),'cipher');assert.ok(!JSON.stringify(argumentsSeen).includes('synthetic'));assert.equal(optionsSeen.env,undefined);assert.equal(Buffer.from(request.data,'base64').toString(),biliFixture);
 const failing=new NativeCookieProtection({platform:'win32',launch(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};child.stdin.on('finish',()=>{child.stderr.write(biliFixture);child.emit('close',1);});return child;}});
 await assert.rejects(failing.run('seal','f'.repeat(64),'bilibili',Buffer.from(biliFixture)),error=>!error.message.includes('synthetic')&&/系统安全存储/.test(error.message));
});
test('Windows CurrentUser DPAPI really restores both platforms and rejects scope changes or tampering',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cookie-dpapi-')),protection=new NativeCookieProtection();
 let vault=await new PlatformCredentials(root,{protection}).initialize();
 t.after(async()=>{await vault.close();await fs.rm(root,{recursive:true,force:true});});
 await vault.save('bilibili',biliFixture);await vault.save('douyin',douyinFixture);
 const sealed=await fs.readFile(vault.file('bilibili'));assert.ok(!sealed.includes(Buffer.from(biliFixture)));
 await vault.close();vault=await new PlatformCredentials(root,{protection}).initialize();
 assert.equal(vault.get('bilibili'),biliFixture);assert.equal(vault.get('douyin'),douyinFixture);
 await assert.rejects(protection.run('open',vault.namespace,'douyin',sealed));
 await assert.rejects(protection.run('open','f'.repeat(64),'bilibili',sealed));
 const damaged=Buffer.from(sealed);damaged[damaged.length-1]^=1;
 await assert.rejects(protection.run('open',vault.namespace,'bilibili',damaged));
 await vault.remove('bilibili');await vault.remove('douyin');assert.deepEqual(await fs.readdir(vault.directory),[]);
});
