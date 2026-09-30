import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { developmentContext,verifyDevelopmentService } from './dev-context.js';
import { importDemo } from './demo.js';

test('开发环境忽略正式 EDITOR_* 环境并隔离数据、导出与端口',()=>{
  const context=developmentContext({EDITOR_DATA:'production',EDITOR_PROJECT_ROOT:'production',EDITOR_PORT:'17860',RECORDER_PORT:'17861'});
  assert.equal(context.port,17960);assert.equal(context.recorderPort,17961);assert.equal(context.uiPort,17962);
  assert.equal(path.basename(context.projectRoot),'development-app');assert.equal(context.data,path.join(context.projectRoot,'data'));
});
test('拒绝正式端口、重复端口与正式根目录',()=>{
  assert.throws(()=>developmentContext({DEV_EDITOR_PORT:'17860'}),/独立开发端口/);
  assert.throws(()=>developmentContext({DEV_RECORDER_PORT:'17960'}),/不能重复/);
  const context=developmentContext({});
  assert.throws(()=>developmentContext({DEV_PROJECT_ROOT:context.runtimeRoot}),/开发目录不能/);
  assert.throws(()=>verifyDevelopmentService({dataPath:path.join(context.runtimeRoot,'程序组件/live-editor/data')},context),/停止导入/);
});
test('demo 在错误数据目录前拒绝生成及 POST',async()=>{
  let generated=0,posts=0;
  await assert.rejects(importDemo({env:{},generate:async()=>{generated++;},fetchImpl:async(url,options)=>{
    if(options.method==='POST')posts++;
    assert.equal(url,'http://127.0.0.1:17960/api/state');
    return {ok:true,json:async()=>({dataPath:path.resolve('wrong-data')})};
  }}),/停止导入/);
  assert.equal(generated,0);assert.equal(posts,0);
});
test('demo 只对匹配的独立服务导入，支持显式 DEV_* 端口',async()=>{
  const env={DEV_EDITOR_PORT:'17970',DEV_RECORDER_PORT:'17971'},context=developmentContext(env),requests=[];
  const result=await importDemo({env,generate:async candidate=>{
    assert.equal(candidate.data,context.data);return path.join(context.data,'demo/test.flv');
  },fetchImpl:async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>options.method==='POST'?{id:'isolated'}:{dataPath:context.data}};
  }});
  assert.equal(result.id,'isolated');assert.equal(requests.length,2);
  assert.equal(requests[1].url,'http://127.0.0.1:17970/api/sessions/import');
  assert.equal(requests[1].options.method,'POST');
});
