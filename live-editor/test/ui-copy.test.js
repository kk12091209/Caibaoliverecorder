import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ui} from '../shared/ui-copy.js';
import {api} from '../src/api.js';

async function sourceFiles(directory){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
    if(entry.isDirectory())files.push(...await sourceFiles(file));
    else if(/\.(vue|js)$/.test(entry.name))files.push(file);
  }
  return files;
}

test('workbench and shared helpers reference existing copy entries',async()=>{
  const files=[...await sourceFiles(new URL('../src/',import.meta.url)),...await sourceFiles(new URL('../shared/',import.meta.url))];
  let references=0;
  for(const file of files){
    const source=await fs.readFile(file,'utf8');
    for(const match of source.matchAll(/\bui\.([a-zA-Z]+)\.([\p{L}\p{N}_]+)/gu)){
      const value=ui[match[1]]?.[match[2]];references++;
      assert.ok(typeof value==='function'||typeof value==='string'&&value.length>0,`Missing copy: ${match[0]} in ${file.pathname}`);
    }
  }
  assert.ok(references>800,'the check must cover the workbench, settings and shared helpers');
});

test('formatted copy preserves names, counters and all export summary fields',()=>{
  assert.equal(ui.workbench.选段导出摘要(3,'00:02:00','两份 MP4'),'3 个选段 · 总时长 00:02:00 · 每段生成两份 MP4');
  assert.equal(ui.workbench.弹幕操作标签('删除','<script>示例</script>'),'删除弹幕：<script>示例</script>');
  assert.equal(ui.lottery.中奖名单待补全(2,5),'名单待补全：2 / 5 人');
  assert.match(ui.messageEditor.编辑文本限制('昵称',200),/昵称不能为空，最多 200 个字符/);
});

test('local connection fallback and server error details remain visible',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('transport detail');});
  await assert.rejects(api('state'),{message:ui.service.本地服务连接失败});
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'磁盘空间不足：可用 2 GiB'}),{status:400});
  await assert.rejects(api('settings'),{message:'磁盘空间不足：可用 2 GiB'});
});
