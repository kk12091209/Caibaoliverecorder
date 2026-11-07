import { json, body } from './http-response.js';
import {messageFeed} from './message-feed.js';
import {giftMessages} from './gifts.js';
import {savedGiftStyle} from '../shared/gifts.js';
import { OVERLAY_MESSAGE_LIMIT, PANEL_MESSAGE_LIMIT } from '../shared/message-limits.js';
import {validateSenderFilter} from '../shared/sender-filter.js';
import {messageEditsKey} from '../shared/message-edits.js';
import { lotteryMessages, lotteryRecord, saveLotteryNote } from './lottery-records.js';

// A matched route returns true after sending its response. Unmatched requests
// continue through the existing authenticated request pipeline.
export async function handleMaterialRoutes({req,res,url,p},{store,media,preparation,deletingSessions,deleteMaterial,recorder,jobDeletion,waveform,density,linkmic}) {
  let match;
  if((match=/^\/api\/sessions\/([\w-]+)$/.exec(p))&&req.method==='GET'){
    const session=store.session(match[1]);if(!session)return json(res,{error:'录像不存在。'},404);
    const sources=store.sources(session.id).map(s=>({id:s.id,start:s.start,wall:s.wall,duration:s.duration,closed:s.closed,error:s.error,path:s.path,metadata:store.setting('metadata:'+s.id)}));
    for(const source of sources)if(!source.metadata&&source.duration>0){void media.probeSource(store.get('SELECT * FROM sources WHERE id=?',source.id)).catch(()=>{});}
    return json(res,{...session,sources,edit:store.edit(session.id),chunks:store.get('SELECT COUNT(*) AS count FROM chunks WHERE source IN (SELECT id FROM sources WHERE session=?)',session.id).count});
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/linkmic-avatars\/([\w-]+)\/([a-f0-9]{64})\.png$/.exec(p))&&req.method==='GET'){
    const asset=store.session(match[1])&&store.get('SELECT a.png FROM linkmic_avatars a JOIN sources s ON s.id=a.source WHERE s.session=? AND a.source=? AND a.hash=?',match[1],match[2],match[3]);
    if(!asset)return json(res,{error:'头像不存在。'},404);
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':asset.png.length,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});
    res.end(Buffer.from(asset.png));return true;
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/linkmic$/.exec(p))&&req.method==='GET'){
    const session=store.session(match[1]);if(!session)return json(res,{error:'录像不存在。'},404);
    const from=Number(url.searchParams.get('from')||0),to=Number(url.searchParams.get('to')||from+60);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to-from>120)throw new Error('名牌预览范围无效。');
    linkmic.request(session.id);
    return json(res,{events:linkmic.events(session.id,from,to),cameraEvents:linkmic.cameraEvents(session.id,from,to)});
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/edit$/.exec(p))&&req.method==='POST'){
    const id=match[1],previous=store.edit(id),saved=store.saveEdit(id,await body(req));
    const visibility=edit=>JSON.stringify([edit.filterLottery!==false,[...edit.excluded].sort(),[...(edit.highlighted||[])].sort(),messageEditsKey(edit.messageEdits)]);
    if(visibility(previous)!==visibility(saved))await preparation.invalidate(id);
    return json(res,saved);
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/delete$/.exec(p))&&req.method==='POST'){
    const input=await body(req),id=match[1];
    if(input.confirmed!==true)throw new Error('请先确认是否永久删除这份素材。');
    if(input.background===true)return json(res,deletingSessions.start(id).accepted,202);
    if(deletingSessions.has(id))throw new Error('这份素材正在删除，请等待完成。');
    const session=store.get('SELECT * FROM sessions WHERE id=?',id);
    if(!session||session.purged_at)throw new Error('素材不存在或已经彻底删除。');
    if(session.status!=='finished'||store.get('SELECT id FROM sources WHERE session=? AND closed<2',id))throw new Error('这份素材仍在录制或整理中，请结束后再删除。');
    if(session.archive_status==='running'||store.get("SELECT id FROM jobs WHERE session=? AND status IN ('queued','running','finalizing','saving','cancelling')",id))throw new Error('这份素材正在导出或保存，请完成后再删除。');
    if(store.get("SELECT id FROM jobs WHERE session=? AND status='save_failed'",id))throw new Error('这份素材还有编码完成但尚未保存的导出，请先重试保存。');
    const controller=new AbortController(),disconnected=()=>{if(!res.writableFinished)controller.abort();};
    res.once('close',disconnected);
    try{return json(res,await deleteMaterial(id,{signal:controller.signal}));}
    finally{res.removeListener('close',disconnected);}
  }
  if((match=/^\/api\/gift-icons\/([a-f0-9]{64})\.png$/.exec(p))&&req.method==='GET'){
    const png=await store.giftIcons.get(match[1]);if(!png)return json(res,{error:'暂无礼物图标。'},404);
    res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});res.end(png);return true;
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/lotteries(?:\/([a-f0-9]{32})(\/note)?)?$/.exec(p))){
    const [,sessionId,recordId,noteRoute]=match;
    if(!store.session(sessionId))return json(res,{error:'素材不存在或已删除。'},404);
    if(recordId){
      if(req.method==='POST'&&noteRoute)return json(res,saveLotteryNote(store,sessionId,recordId,await body(req,8192)));
      if(req.method==='GET'&&!noteRoute){const record=lotteryRecord(store,sessionId,recordId);return record?json(res,record):json(res,{error:'天选记录不存在。'},404);}
    }else if(req.method==='GET'){
      const from=Number(url.searchParams.get('from')||0),to=Number(url.searchParams.get('to')||Number.MAX_SAFE_INTEGER),at=url.searchParams.has('at')?Number(url.searchParams.get('at')):undefined;
      if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from||at!==undefined&&(!Number.isFinite(at)||at<from||at>to))throw new Error('天选记录时间范围无效。');
      return json(res,lotteryMessages(store,sessionId,{from,to,at,search:(url.searchParams.get('q')||'').slice(0,200)}));
    }
    return json(res,{error:'请求方式无效。'},405);
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/gifts$/.exec(p))&&req.method==='GET'){
    const id=match[1];if(!store.session(id))return json(res,{error:'素材不存在或已删除。'},404);
    const from=Number(url.searchParams.get('from')||0),to=Number(url.searchParams.get('to')||Number.MAX_SAFE_INTEGER),at=url.searchParams.has('at')?Number(url.searchParams.get('at')):undefined;
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from||at!==undefined&&(!Number.isFinite(at)||at<from||at>to))throw new Error('礼物时间范围无效。');
    const includeSuperChat = url.searchParams.get('includeSuperChat') === '1';
    const events=giftMessages(store,id,{from,to,at,search:(url.searchParams.get('q')||'').slice(0,200),limit:500,style:savedGiftStyle(store),includeSuperChat});
    void store.giftIcons.enrich(events).catch(()=>{});
    return json(res,events);
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/feed$/.exec(p))&&req.method==='GET'){
    const id=match[1];if(!store.session(id))return json(res,{error:'素材不存在或已删除。'},404);
    const params=url.searchParams,at=params.has('at')?Number(params.get('at')):undefined;
    if(at!==undefined&&(!Number.isFinite(at)||at<0))throw new Error('列表定位时间无效。');
    const sender=validateSenderFilter(params.has('sender')?JSON.parse(params.get('sender')):null);
    const search=(params.get('q')||'').trim().slice(0,200);
    await store.chatRules.prepare(id);await store.senders.prepare(id);
    if(/^[1-9]\d{0,30}$/.test(search))await store.senders.prepare(id,true);
    const page=messageFeed(store,id,{at,sender,from:params.has('from')?Number(params.get('from')):0,to:params.has('to')?Number(params.get('to')):undefined,search,gifts:params.get('gifts')==='1',onlyGifts:params.get('onlyGifts')==='1',
      cursor:params.has('cursor')?JSON.parse(params.get('cursor')):undefined,direction:params.get('direction')||'after'});
    void store.giftIcons.enrich(page.rows.filter(row=>row.type!=='d'&&row.type!=='lottery')).catch(()=>{});
    return json(res,page);
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/messages$/.exec(p))&&req.method==='GET'){
    if(!store.session(match[1]))return json(res,{error:'素材不存在或已删除。'},404);
    const from=Math.max(0,Number(url.searchParams.get('from')||0)),to=Number(url.searchParams.get('to')||Number.MAX_SAFE_INTEGER),search=(url.searchParams.get('q')||'').slice(0,200);
    if(!Number.isFinite(from)||!Number.isFinite(to))throw new Error('时间范围无效。');
    const atParameter=url.searchParams.get('at'),at=atParameter===null?undefined:Number(atParameter),overlay=url.searchParams.get('overlay')==='1';
    if(atParameter!==null&&(!atParameter.trim()||!Number.isFinite(at)||at<from||at>to))throw new Error('弹幕跟随时间无效。');
    await store.chatRules.prepare(match[1]);
    const sender=overlay?null:validateSenderFilter(url.searchParams.has('sender')?JSON.parse(url.searchParams.get('sender')):null);
    if(!overlay)await store.senders.prepare(match[1]);
    return json(res,store.messages(match[1],from,to,search,overlay?OVERLAY_MESSAGE_LIMIT:PANEL_MESSAGE_LIMIT,undefined,!overlay&&!search&&!sender?at:undefined,sender));
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/signals$/.exec(p))&&req.method==='GET'){
    const id=match[1],session=store.session(id);
    if(!session)return json(res,{error:'素材不存在或已删除。'},404);
    if(deletingSessions.has(id))throw new Error('素材正在删除，请稍后再试。');
    const from=Number(url.searchParams.get('from')??0),to=Number(url.searchParams.get('to')??session.duration),bins=Number(url.searchParams.get('bins')??600);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>session.duration+.05||!Number.isInteger(bins)||bins<1||bins>1000)throw new Error('波形时间范围无效。');
    const window={from,to:Math.min(to,session.duration),bins};
    return json(res,{from:window.from,to:window.to,audio:waveform.request(id,window),density:density.request(id,window)});
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/preview$/.exec(p))&&req.method==='GET'){
    const start=Number(url.searchParams.get('start')||0);if(!Number.isFinite(start)||start<0)throw new Error('播放位置无效。');
    const client=url.searchParams.get('client'),sequence=Number(url.searchParams.get('sequence'));
    if(!client&&url.searchParams.has('sequence'))throw new Error('预览请求标识无效。');
    const abort=new AbortController();res.on('close',()=>abort.abort());await media.preview(match[1],start,res,abort.signal,{client,sequence});return true;
  }
  if((match=/^\/api\/previews\/([a-zA-Z0-9_-]+)\/stop$/.exec(p))&&req.method==='POST'){
    const input=await body(req);media.previewRequests.stop(match[1],input?.sequence);return json(res,{ok:true});
  }
  if((match=/^\/api\/sessions\/([\w-]+)\/export$/.exec(p))&&req.method==='POST')return json(res,await media.enqueue(match[1],await body(req)));
  if((match=/^\/api\/jobs\/([\w-]+)\/retry-save$/.exec(p))&&req.method==='POST')return json(res,await media.retrySave(match[1],await body(req)));
  if((match=/^\/api\/jobs\/([\w-]+)\/retry$/.exec(p))&&req.method==='POST'){await body(req);return json(res,await media.retryExport(match[1]));}
  if((match=/^\/api\/jobs\/([\w-]+)\/cancel$/.exec(p))&&req.method==='POST'){await body(req);return json(res,await media.cancelExport(match[1]));}
  if((match=/^\/api\/jobs\/([\w-]+)\/delete-preview$/.exec(p))&&req.method==='GET')return json(res,await jobDeletion.preview(match[1]));
  if((match=/^\/api\/jobs\/([\w-]+)\/delete$/.exec(p))&&req.method==='POST')return json(res,await jobDeletion.delete(match[1],await body(req)));
  return false;
}
