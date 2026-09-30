import { statSync } from 'node:fs';
import path from 'node:path';

const tools={
  ffmpeg:{component:'ffmpeg',name:'ffmpeg',variable:'FFMPEG_PATH',label:'FFmpeg'},
  ffprobe:{component:'ffmpeg',name:'ffprobe',variable:'FFPROBE_PATH',label:'FFprobe'},
  recorder:{component:'recorder',name:'BililiveRecorder.Cli',variable:'RECORDER_PATH',label:'录制核心'}
};
const isFile=file=>{try{return statSync(file).isFile();}catch{return false;}};
const clean=value=>String(value||'').trim().replace(/^"(.*)"$/,'$1');

// A source checkout may live beside an installed application's components.
export function resolveProjectRoot(appRoot,explicitRoot=process.env.EDITOR_PROJECT_ROOT) {
  if(clean(explicitRoot))return path.resolve(clean(explicitRoot));
  const parent=path.dirname(path.resolve(appRoot));
  if(path.basename(parent)==='程序组件')return path.dirname(parent);
  if(path.basename(parent)==='源码'&&isFile(path.join(path.dirname(parent),'程序组件','live-editor','server','index.js')))
    return path.dirname(parent);
  return parent;
}

export function resolveRuntimeTool(projectRoot,kind,{override,env=process.env,platform=process.platform,required=true}={}) {
  // Caller-supplied tools also support tests and custom deployments.
  if(override!==undefined&&override!==null)return override;
  const tool=tools[kind];if(!tool)throw new Error('未知运行组件：'+kind);
  projectRoot=resolveProjectRoot(path.join(projectRoot,'live-editor'),env.EDITOR_PROJECT_ROOT||'');
  const executable=tool.name+(platform==='win32'?'.exe':'');
  const componentRoot=path.join(projectRoot,'程序组件');
  const bundled=path.join(componentRoot,'runtime',tool.component,executable);
  if(isFile(bundled))return bundled;
  const pathValue=env.PATH??env.Path??'';
  const searchPath=name=>{
    for(const entry of pathValue.split(platform==='win32'?';':':')){
      const directory=clean(entry);if(!directory)continue;
      const file=path.resolve(directory,name);
      if(isFile(file))return file;
    }
    return null;
  };
  const configured=clean(env[tool.variable]);
  if(configured){
    const explicit=path.isAbsolute(configured)||/[\\/]/.test(configured)
      ?path.resolve(projectRoot,configured)
      :searchPath(configured)||((platform==='win32'&&!path.extname(configured))?searchPath(configured+'.exe'):null);
    if(explicit&&isFile(explicit))return explicit;
    throw new Error(tool.label+' 路径无效：'+configured+'。请修正 '+tool.variable+'，或恢复 程序组件/runtime/'+tool.component+'/'+executable+'。');
  }
  const found=searchPath(executable);if(found)return found;
  if(!required)return bundled;
  throw new Error('缺少 '+tool.label+'。请完整解压发布包，保留 程序组件/runtime/'+tool.component+'/'+executable+'；自行配置时可使用 '+tool.variable+' 环境变量或 PATH。');
}
