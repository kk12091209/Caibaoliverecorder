import {ui} from './ui-copy.js';

export function platformLabel(platform){
  return {bilibili:ui.common.B站,douyin:ui.common.抖音,xiaohongshu:ui.common.小红书}[platform]||ui.common.未知来源;
}
