import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { developmentContext } from './dev-context.js';

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
});
