import { json, body } from './http-response.js';

// A matched route returns true after sending its response. Unmatched requests
// continue through the existing authenticated request pipeline.
export async function handleSystemRoutes({req,res,url,p},{updates,credentials,recorder,cookieValidation,credentialSnapshot}) {
  let match;
  if(p==='/api/updates/apply'&&req.method==='POST'){const input=await body(req);return json(res,updates.requestInstall(input?.key));}
  if(p==='/api/updates/check'&&req.method==='POST'){await body(req);return json(res,await updates.check());}
  if(p==='/api/updates/download'&&req.method==='POST'){const input=await body(req);return json(res,updates.download(input.key,input.autoInstall===true),202);}
  if(p==='/api/updates/clear'&&req.method==='POST'){await body(req);return json(res,await updates.clearCache());}
  if(p==='/api/updates/cancel'&&req.method==='POST'){await body(req);return json(res,updates.cancel());}
  if(p==='/api/updates/defer'&&req.method==='POST'){await body(req);return json(res,updates.defer());}
  if(p==='/api/updates/ignore'&&req.method==='POST'){
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!('key' in input))throw new Error('版本提醒设置无效。');
    return json(res,updates.ignoreVersion(input.key));
  }
  if(p==='/api/updates/channel'&&req.method==='POST'){const input=await body(req);return json(res,await updates.setBetaEnabled(input?.betaEnabled));}
  if(p==='/api/updates/settings'&&req.method==='POST'){const input=await body(req);return json(res,updates.setEnabled(input.enabled));}
  if(p==='/api/platform-credentials'&&req.method==='GET')return json(res,credentialSnapshot());
  if((match=/^\/api\/platform-credentials\/(bilibili|douyin|xiaohongshu)\/(save|delete|verify|unlock|acknowledge)$/.exec(p))&&req.method==='POST'){
    const [,platform,action]=match,input=await body(req,65536);
    const adapter=recorder.platforms.get(platform);
    if(action==='acknowledge'){
      if(!input||Object.keys(input).length!==1||typeof input.generation!=='string'||!/^[a-f0-9]{64}$/.test(input.generation))throw new Error('Cookie 提醒请求无效。');
      credentials.acknowledge(platform,input.generation);
      return json(res,{ok:true});
    }
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>action!=='save'||key!=='cookie'))throw new Error('登录信息请求无效。');
    if(action==='save')await credentials.save(platform,input.cookie);
    else if(action==='delete')await credentials.remove(platform);
    else if(action==='unlock')await credentials.unlock(platform);
    else {
      if(!credentials.get(platform)&&!credentials.isExpired(platform))throw new Error('请先保存 Cookie。');
      await cookieValidation.check(platform,{force:true});
      return json(res,credentialSnapshot());
    }
    const applied=await adapter.applySavedCredentials();
    return json(res,{...credentialSnapshot(),applyStatus:applied});
  }
  return false;
}
