import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createApp} from '../server/index.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const root=await fs.mkdtemp('/private/tmp/caibao-upgrade-ui-'),out=process.env.VERIFY_OUTPUT||'/private/tmp/caibao-upgrade-local-20261101/recorder-ui';await fs.mkdir(out,{recursive:true});
const app=await createApp({data:root,port:0,noRecorder:true,ffmpeg:'not-used',ffprobe:'not-used',updatesAutoCheck:false,douyinFollow:{discovery:{monitorIdentity:async()=>({uid:'9007199254740993999',secUid:'LOCAL_FIXTURE',name:'本地测试用户',profile:'https://www.douyin.com/user/LOCAL_FIXTURE'}),observe:async()=>({state:'unknown',reason:'本地受控测试'})}}});
let browser;try{
 await app.startupRecovery;app.recorder.douyin.started=true;app.recorder.following.started=true;
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({httpCredentials:{username:'caibao',password:app.runtime.uiToken},viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(app.runtime.origin);await page.getByLabel('主播直播间或抖音名片分享内容').fill('https://www.douyin.com/user/LOCAL_FIXTURE');await page.getByRole('button',{name:'添加',exact:true}).click();
 await page.getByText('本地测试用户',{exact:true}).waitFor();await page.getByText('待确认：本地受控测试',{exact:true}).waitFor();
 await page.getByRole('button',{name:'停止监控：本地测试用户',exact:true}).click();await page.getByText('已停止',{exact:true}).waitFor();
 const status=await page.evaluate(async()=>({state:(await fetch('/api/state')).status}));assert.equal(status.state,200);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(out,'follow-users.png'),fullPage:true});
 const denied=await browser.newContext();const response=await denied.request.get(app.runtime.origin+'/api/state');assert.equal(response.status(),401);
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify({authenticatedUI:true,userBinding:true,toggle:true,anonymousStatus:response.status(),errors},null,2));console.log('Authenticated UI, bind, enable/disable and anonymous denial passed');
}finally{await browser?.close();await app.close();await fs.rm(root,{recursive:true,force:true});}
