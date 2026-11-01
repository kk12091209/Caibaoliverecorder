import {requireLocalAccess} from '../server/local-access.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { developmentContext, developmentTool } from './dev-context.js';

export async function startDevelopment({env=process.env,ui=true}={}) {
  const context=developmentContext(env);
  const {createApp}=await import('../server/index.js');
  const options={data:context.data,projectRoot:context.projectRoot,port:context.port,recorderPort:context.recorderPort,
    noRecorder:context.noRecorder,ffmpeg:developmentTool(context,'ffmpeg',env),ffprobe:developmentTool(context,'ffprobe',env)};
  if(!context.noRecorder)options.recorder=developmentTool(context,'recorder',env);
  const app=await createApp(options);
  let vite,closing;
  const close=()=>closing??=(async()=>{await vite?.close();await app.close();})();
  try {
    if(ui) {
      const {createServer}=await import('vite');
      vite=await createServer({root:context.appRoot,configFile:path.join(context.appRoot,'vite.config.js'),
        plugins:[{name:'private-development-access',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.headers.host!==`127.0.0.1:${context.uiPort}`&&req.headers.host!==`localhost:${context.uiPort}`){res.writeHead(403);res.end();return;}if(requireLocalAccess(req,res,app.runtime))next();});}}],
        server:{host:'127.0.0.1',port:context.uiPort,strictPort:true,proxy:{'/api':{
          target:context.origin,changeOrigin:true,
          configure(proxy) { proxy.on('proxyReq',(outgoing,incoming)=>{
            if(incoming.headers.origin==='http://'+incoming.headers.host&&
              ['127.0.0.1:'+context.uiPort,'localhost:'+context.uiPort].includes(incoming.headers.host))
              outgoing.setHeader('origin',context.origin);
          }); }
        }}}});
      await vite.listen();
    }
  } catch(error) { await close();throw error; }
  return {app,vite,context,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const development=await startDevelopment({ui:!process.argv.includes('--no-ui')});
    console.log('独立开发环境：'+(development.vite?'http://127.0.0.1:'+development.context.uiPort:development.context.origin));
    console.log('开发数据与导出根：'+development.context.projectRoot);
    console.log('浏览器登录用户名 caibao；密码为私有文件 '+development.app.runtime.file+' 中的 uiToken。不要分享这个文件。');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await development.close();process.exit(0);});
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
