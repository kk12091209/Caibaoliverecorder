import { ui } from './ui-copy.js';
import {isGiftEvent} from './lottery-records.js';
export const GIFT_SETTING='gift-style';
export const DEFAULT_GIFT_STYLE=Object.freeze({preview:false,export:false,minBilibili:0,minDouyin:0,currency:'CNY'});
export function validateGiftStyle(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_GIFT_STYLE,k))||
    typeof value.preview!=='boolean'||typeof value.export!=='boolean'||
    value.currency!==undefined&&value.currency!=='CNY'||
    !['minBilibili','minDouyin'].every(k=>Number.isFinite(value[k])&&value[k]>=0&&value[k]<=1000000000))throw new Error(ui.gifts.礼物筛选无效);
  // Earlier local settings used Douyin coins. Preserve the same threshold value.
  return {preview:value.preview,export:value.export,minBilibili:value.minBilibili,minDouyin:value.currency===undefined?value.minDouyin/10:value.minDouyin,currency:'CNY'};
}
export function normalizedGiftStyle(value){try{return validateGiftStyle(value);}catch{return {...DEFAULT_GIFT_STYLE};}}
export const savedGiftStyle=store=>normalizedGiftStyle(store.setting(GIFT_SETTING));
export function giftEligible(gift,style){
  if(!isGiftEvent(gift))return false;
  const minimum=gift.platform==='douyin'?style.minDouyin:style.minBilibili;
  const yuan=giftYuan(gift);return minimum===0||(yuan!==null&&yuan>=minimum);
}
export const giftYuan=gift=>gift.totalPrice===null||!Number.isFinite(gift.totalPrice)?null:gift.platform==='douyin'?gift.totalPrice/10:gift.totalPrice;
export function giftPrice(gift){
  const yuan=giftYuan(gift);if(yuan===null)return ui.gifts.金额未知;
  return `¥${Number(yuan.toFixed(3))}`;
}
export const giftDescription=gift=>`${gift.user} · ${gift.name} × ${gift.count} · ${giftPrice(gift)}`;
export const GIFT_SECONDS=5;
export const SUPER_CHAT_SECONDS = 10;
export function giftCards(events, time) {
  const active = events.filter(gift => {
    if (gift.type !== 'sc' && !isGiftEvent(gift)) return false;
    const duration = gift.type === 'sc' ? SUPER_CHAT_SECONDS : GIFT_SECONDS;
    return gift.time <= time && time < gift.time + duration;
  });
  const superChats = active.filter(gift => gift.type === 'sc').slice(-3).reverse();
  if (superChats.length === 3) return superChats;
  const gifts = active.filter(isGiftEvent).slice(-(3 - superChats.length));
  return [...superChats, ...gifts];
}
export function giftGeometry(width,height,lane=0){
  const scale=height/720,w=Math.min(width*.85,410*scale),h=64*scale,margin=16*scale;
  return {x:width-margin-w,y:margin+lane*(h+8*scale),w,h,size:19*scale,icon:42*scale,pad:10*scale};
}
