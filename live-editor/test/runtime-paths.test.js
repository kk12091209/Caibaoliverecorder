import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveRuntimeTool,resolveProjectRoot} from '../server/runtime-paths.js';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'recorder-portable-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=relative=>{const full=path.join(root,relative);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,'test fixture');return full;};
  return {root,file};
}

test('移动发布目录后优先找到包内组件，不依赖开发电脑盘符或 PATH',t=>{
  const {root,file}=fixture(t),bundled=file('程序组件/runtime/ffmpeg/ffmpeg.exe');
  const external=file('outside/ffmpeg.exe');
  const moved=root+'-moved';fs.renameSync(root,moved);t.after(()=>fs.rmSync(moved,{recursive:true,force:true}));
  assert.equal(resolveRuntimeTool(moved,'ffmpeg',{platform:'win32',env:{FFMPEG_PATH:external,PATH:''}}),path.join(moved,path.relative(root,bundled)));
});

test('调用方显式配置优先于包内组件，保留测试和自定义部署能力',t=>{
  const {root,file}=fixture(t);file('程序组件/runtime/ffmpeg/ffmpeg.exe');
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{override:'custom-test-encoder',platform:'win32',env:{PATH:''}}),'custom-test-encoder');
});

test('无包内组件时支持有空格的显式路径、相对路径以及 PATH',t=>{
  const {root,file}=fixture(t),configured=file('自定义 components/ffmpeg.exe'),probe=file('bin/ffprobe.exe');
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env:{FFMPEG_PATH:`"${configured}"`,PATH:''}}),configured);
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env:{FFMPEG_PATH:'自定义 components/ffmpeg.exe',PATH:''}}),configured);
  assert.equal(resolveRuntimeTool(root,'ffprobe',{platform:'win32',env:{Path:path.dirname(probe)}}),probe);
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env:{FFMPEG_PATH:'ffmpeg',PATH:path.dirname(configured)}}),configured);
});

test('缺失或错误组件提示可恢复的文件和配置名，不把目录当可执行文件',t=>{
  const {root,file}=fixture(t);const fake=file('程序组件/runtime/ffmpeg/ffmpeg.exe/unrelated');
  assert.throws(()=>resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env:{PATH:''}}),/缺少 FFmpeg.*runtime\/ffmpeg\/ffmpeg.exe/);
  assert.throws(()=>resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env:{FFMPEG_PATH:path.dirname(fake),PATH:''}}),/FFMPEG_PATH/);
  assert.equal(resolveRuntimeTool(root,'recorder',{platform:'win32',env:{PATH:''},required:false}),path.join(root,'程序组件/runtime/recorder/BililiveRecorder.Cli.exe'));
});

test('新发行布局优先程序组件内的运行依赖，兼容以组件目录调用',t=>{
  const {root,file}=fixture(t),bundled=file('程序组件/runtime/ffmpeg/ffmpeg.exe');
  file('runtime/ffmpeg/ffmpeg.exe');
  const options={platform:'win32',env:{PATH:''}};
  assert.equal(resolveRuntimeTool(root,'ffmpeg',options),bundled);
  assert.equal(resolveRuntimeTool(path.join(root,'程序组件'),'ffmpeg',options),bundled);
  assert.equal(resolveProjectRoot(path.join(root,'程序组件/live-editor'),''),root);
  assert.equal(resolveRuntimeTool(root,'recorder',{...options,required:false}),path.join(root,'程序组件/runtime/recorder/BililiveRecorder.Cli.exe'));
});

test('源码归档目录借用外层安装，纯源码目录仍可独立使用',t=>{
  const {root,file}=fixture(t);
  const source=path.join(root,'源码/live-editor');
  assert.equal(resolveProjectRoot(source,''),path.join(root,'源码'));
  file('程序组件/live-editor/server/index.js');
  const bundled=file('程序组件/runtime/ffmpeg/ffmpeg.exe');
  assert.equal(resolveProjectRoot(source,''),root);
  assert.equal(resolveProjectRoot(path.join(root,'live-editor'),''),root);
  assert.equal(resolveRuntimeTool(path.join(root,'源码'),'ffmpeg',{platform:'win32',env:{PATH:''}}),bundled);
});

test('显式项目根优先且不会破坏调用方工具覆盖',t=>{
  const {root,file}=fixture(t),bundled=file('目标根/程序组件/runtime/ffmpeg/ffmpeg.exe');
  const target=path.join(root,'目标根');
  const env={EDITOR_PROJECT_ROOT:target,PATH:''};
  assert.equal(resolveProjectRoot(path.join(root,'源码/live-editor'),target),target);
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{platform:'win32',env}),bundled);
  assert.equal(resolveRuntimeTool(root,'ffmpeg',{override:'injected',env}),'injected');
});
