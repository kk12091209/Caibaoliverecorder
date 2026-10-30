export const HIGHLIGHT_SETTING='danmaku-highlight-style';
export const DEFAULT_HIGHLIGHT_STYLE=Object.freeze({scale:1,showSender:false,color:null});
export function validateHighlightStyle(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_HIGHLIGHT_STYLE,k))||
    !Number.isFinite(value.scale)||value.scale<1||value.scale>3||typeof value.showSender!=='boolean'||
    value.color!==null&&!/^#[0-9a-f]{6}$/i.test(value.color))throw new Error('突出弹幕字号须为 1～3 倍，请选择有效颜色和发送者显示方式。');
  return {scale:Math.round(value.scale*100)/100,showSender:value.showSender,color:value.color?.toUpperCase()??null};
}
export function normalizedHighlightStyle(value){try{return validateHighlightStyle(value);}catch{return {...DEFAULT_HIGHLIGHT_STYLE};}}
export const savedHighlightStyle=store=>normalizedHighlightStyle(store.setting(HIGHLIGHT_SETTING));
export function highlightPresentation(message,size,value){
  const style=normalizedHighlightStyle(value),highlighted=message.highlighted===true;
  return {text:String(highlighted&&style.showSender?`${message.user||'观众'}：${message.text}`:message.text),
    fontSize:highlighted?Number((size*style.scale).toFixed(3)):size,
    renderColor:highlighted&&style.color?parseInt(style.color.slice(1),16):Number(message.color)||16777215};
}
