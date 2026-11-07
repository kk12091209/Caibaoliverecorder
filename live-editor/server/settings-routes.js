import { json, body } from './http-response.js';
import { writableDirectory, openDirectory } from './directories.js';
import { chatRate, validateChatRate, CHAT_RATE_SETTING } from './chat-rules.js';
import { GIFT_SETTING, validateGiftStyle } from '../shared/gifts.js';
import { savedDanmakuStyle, validateDanmakuStyle, DANMAKU_STYLE_SETTING } from '../shared/danmaku-style.js';
import { savedRecordingStyle, validateRecordingStyle, RECORDING_STYLE_SETTING } from '../shared/recording-style.js';
import { HIGHLIGHT_SETTING, savedHighlightStyle, validateHighlightStyle } from '../shared/highlight-style.js';
import { validateTimestampStyle, TIMESTAMP_STYLE_SETTING, validateTimestampPosition, TIMESTAMP_POSITION_SETTING } from '../shared/timestamp-style.js';

// A matched route returns true after sending its response. Unmatched requests
// continue through the existing authenticated request pipeline.
export async function handleSettingsRoutes({req,res,p},{store,media,stylePreview,settingsSnapshot,validateCloseAction,recorder,preparation}) {
  if(p==='/api/danmaku-style/preview'&&req.method==='POST'){
    const input=await body(req),controller=new AbortController();res.once('close',()=>controller.abort());
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(input.motion===true?30000:15000)]);
    const result=await stylePreview.render(input,signal);
    if(!result){if(res.destroyed)return true;throw new Error('样式预览超时，请重试。');}
    const {bytes,samples,contentType}=result;
    res.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store','Content-Length':bytes.length,'X-Danmaku-Preview-Count':samples});res.end(bytes);return true;
  }
  if(p==='/api/settings'&&req.method==='POST'){
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['exportDirectory','closeAction','danmakuPerSecond','danmakuStyle','highlightStyle','danmakuFont','previewTimestamp','previewTimestampStyle','previewTimestampPosition','recordingStyle','giftStyle'].includes(key)))throw new Error('不支持的设置项。');
    const giftStyle='giftStyle' in input?validateGiftStyle(input.giftStyle):null;
    const highlightStyle='highlightStyle' in input?validateHighlightStyle(input.highlightStyle):null;
    if('closeAction' in input)validateCloseAction(input.closeAction);
    if('previewTimestamp' in input&&typeof input.previewTimestamp!=='boolean')throw new Error('请选择是否显示预览时间戳。');
    const timestampStyle='previewTimestampStyle' in input?validateTimestampStyle(input.previewTimestampStyle):undefined;
    const timestampPosition='previewTimestampPosition' in input?validateTimestampPosition(input.previewTimestampPosition):undefined;
    if('danmakuPerSecond' in input)validateChatRate(input.danmakuPerSecond);
    const style='danmakuStyle' in input?validateDanmakuStyle(input.danmakuStyle):null;
    const recordingStyle='recordingStyle' in input?validateRecordingStyle(input.recordingStyle):null;
    if(media.fonts.changing)throw new Error('正在保存字体，请稍后重试。');
    media.fonts.changing=true;
    try{
      const font='danmakuFont' in input?await media.fonts.selection(input.danmakuFont):undefined;
      const directory='exportDirectory' in input?await writableDirectory(input.exportDirectory):undefined;
      const changed=(style&&JSON.stringify(style)!==JSON.stringify(savedDanmakuStyle(store)))||
        (highlightStyle&&JSON.stringify(highlightStyle)!==JSON.stringify(savedHighlightStyle(store)))||
        (recordingStyle&&JSON.stringify(recordingStyle)!==JSON.stringify(savedRecordingStyle(store)))||
        (font!==undefined&&(font?.id||null)!==(media.fonts.snapshot()?.id||null))||
        ('danmakuPerSecond' in input&&input.danmakuPerSecond!==chatRate(store));
      store.transaction(()=>{
        if(directory!==undefined)store.setting('export-directory',directory);
        if('closeAction' in input)store.setting('window-close-action',input.closeAction);
        if('previewTimestamp' in input)store.setting('preview-timestamp',input.previewTimestamp);
        if(timestampStyle!==undefined)store.setting(TIMESTAMP_STYLE_SETTING,timestampStyle);
        if(timestampPosition!==undefined)store.setting(TIMESTAMP_POSITION_SETTING,timestampPosition);
        if('danmakuPerSecond' in input)store.setting(CHAT_RATE_SETTING,input.danmakuPerSecond);
        if(style)store.setting(DANMAKU_STYLE_SETTING,style);
        if(highlightStyle)store.setting(HIGHLIGHT_SETTING,highlightStyle);
        if(recordingStyle)store.setting(RECORDING_STYLE_SETTING,recordingStyle);
        if(giftStyle)store.setting(GIFT_SETTING,giftStyle);
        if(font!==undefined)store.setting('danmaku-font',font);
      });
      if('danmakuPerSecond' in input)for(const platform of recorder.platforms.values())platform.setChatRateLimit?.(input.danmakuPerSecond);
      if(changed)for(const {session} of store.all('SELECT session FROM preparation_jobs'))await preparation.invalidate(session);
      return json(res,{ok:true,...settingsSnapshot()});
    }finally{media.fonts.changing=false;}
  }
  if(p==='/api/folders/open'&&req.method==='POST')return json(res,{path:await openDirectory(store,await body(req))});
  return false;
}
