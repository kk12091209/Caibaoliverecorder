import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { developmentContext, developmentTool, verifyDevelopmentService } from './dev-context.js';

async function generateDemo(context,env) {
  const folder=path.join(context.data,'demo');await fs.mkdir(folder,{recursive:true});
  const video=path.join(folder,'local-test.flv');
  execFileSync(developmentTool(context,'ffmpeg',env),['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','30','-c:v','libx264','-preset','ultrafast','-g','90','-keyint_min','90','-sc_threshold','0','-bf','0','-c:a','aac','-y',video],{windowsHide:true});
  const comments=[[2,'观众A','画面很清楚'],[5,'观众B','这一段可以保留'],[8,'观众C','精彩瞬间'],[12,'观众D','继续加油'],[16,'观众A','这是一条可删除的测试弹幕'],[22,'观众B','原始弹幕会完整保留']];
  await fs.writeFile(video.replace('.flv','.xml'),'<?xml version="1.0" encoding="UTF-8"?><i>'+comments.map(([t,u,c])=>'<d p="'+t+',1,25,16777215,0,0,0,0" user="'+u+'">'+c+'</d>').join('')+'</i>');
  return video;
}
export async function importDemo({env=process.env,fetchImpl=fetch,generate=generateDemo}={}) {
  const context=developmentContext(env);
  const stateResponse=await fetchImpl(context.origin+'/api/state',{signal:AbortSignal.timeout(5000)});
  if(!stateResponse.ok)throw new Error('开发服务不可用，请先运行 npm run dev。');
  verifyDevelopmentService(await stateResponse.json(),context);
  // Verify ownership before creating media or making any modifying request.
  const video=await generate(context,env);
  const response=await fetchImpl(context.origin+'/api/sessions/import',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({path:video,title:'本地测试录像（30秒）'}),signal:AbortSignal.timeout(10000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error);
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log('已导入独立开发环境的测试录像：'+(await importDemo()).id); }
  catch(error) { console.error('演示素材未导入：'+error.message);process.exitCode=1; }
}
