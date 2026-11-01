// Integration fixtures use the same HTTP Basic credential as the desktop UI.
// This helper changes test requests only; the service has no test auth bypass.
import {createApp as createService} from '../../server/index.js';
const credentials=new Map();
export async function createApp(options){
 const app=await createService(options),origin=app.runtime.origin;
 credentials.set(origin,'Basic '+Buffer.from('caibao:'+app.runtime.uiToken).toString('base64'));
 const close=app.close.bind(app);app.close=async()=>{try{return await close();}finally{credentials.delete(origin);}};return app;
}
export function fetch(input,options={}){
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 const headers=new Headers(options.headers|| (input instanceof Request?input.headers:undefined));
 if(url.pathname.startsWith('/api/')&&credentials.has(url.origin)&&!headers.has('Authorization'))headers.set('Authorization',credentials.get(url.origin));
 return globalThis.fetch(input,{...options,headers});
}
