const uid=value=>typeof value==='string'&&/^[1-9]\d{0,30}$/.test(value);
export function senderFilterFor(message){
  if(uid(message.senderId)&&['bilibili','douyin'].includes(message.senderPlatform))return {mode:'uid',platform:message.senderPlatform,uid:message.senderId,name:message.user};
  const name=String(message.user||'').trim();if(!name||['观众','匿名','匿名用户'].includes(name))return null;
  const parts=name.split(/[*＊]{2,}|…+|\.{3,}/u);
  return parts.length===2&&parts[0]&&parts[1]?{mode:'approx',name,prefix:parts[0],suffix:parts[1]}:{mode:'name',name};
}
export function validateSenderFilter(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||typeof value.name!=='string'||!value.name.trim()||value.name.length>200)throw new Error('发送者筛选条件无效。');
  if(value.mode==='uid'&&uid(value.uid)&&['bilibili','douyin'].includes(value.platform)&&Object.keys(value).every(k=>['mode','name','uid','platform'].includes(k)))return {mode:'uid',name:value.name,uid:value.uid,platform:value.platform};
  if(value.mode==='name'&&Object.keys(value).every(k=>['mode','name'].includes(k)))return {mode:'name',name:value.name};
  if(value.mode==='approx'&&Object.keys(value).every(k=>['mode','name','prefix','suffix'].includes(k))&&[value.prefix,value.suffix].every(x=>typeof x==='string'&&x.length>0&&x.length<=200))return {mode:'approx',name:value.name,prefix:value.prefix,suffix:value.suffix};
  throw new Error('发送者筛选条件无效。');
}
export function matchesSender(message,filter){
  if(!filter)return true;
  if(filter.mode==='uid')return message.senderId===filter.uid&&message.senderPlatform===filter.platform;
  if(filter.mode==='name')return message.user===filter.name;
  return message.user?.startsWith(filter.prefix)&&message.user?.endsWith(filter.suffix);
}
