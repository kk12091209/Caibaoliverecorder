import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot, resolveRuntimeTool } from '../server/runtime-paths.js';

export const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export function developmentContext(env=process.env,source=appRoot) {
  const sourceRoot=path.dirname(source),runtimeRoot=resolveProjectRoot(source,'');
  const projectRoot=path.resolve(env.DEV_PROJECT_ROOT||path.join(sourceRoot,'.tools','development-app'));
  const data=path.join(projectRoot,'data');
  if([sourceRoot,runtimeRoot].some(root=>samePath(root,projectRoot)) ||
    [path.join(source,'data'),path.join(runtimeRoot,'程序组件','live-editor','data')].some(root=>samePath(root,data)))
    throw new Error('开发目录不能指向源码或正式软件的数据目录，请使用独立 DEV_PROJECT_ROOT。');
  const port=(name,fallback)=>{
    const value=Number(env[name]||fallback);
    if(!Number.isInteger(value)||value<1024||value>65535||value===17860||value===17861)
      throw new Error(name+' 必须使用独立开发端口（1024–65535，不能为 17860/17861）。');
    return value;
  };
  const editorPort=port('DEV_EDITOR_PORT',17960),recorderPort=port('DEV_RECORDER_PORT',17961),uiPort=port('DEV_UI_PORT',17962);
  if(new Set([editorPort,recorderPort,uiPort]).size!==3)throw new Error('开发服务、录制核心和界面端口不能重复。');
  return {appRoot:source,runtimeRoot,projectRoot,data,port:editorPort,recorderPort,uiPort,origin:'http://127.0.0.1:'+editorPort,noRecorder:env.DEV_NO_RECORDER==='1'};
}
export function developmentTool(context,kind,env=process.env) {
  return resolveRuntimeTool(context.runtimeRoot,kind,{env:{...env,EDITOR_PROJECT_ROOT:''}});
}
