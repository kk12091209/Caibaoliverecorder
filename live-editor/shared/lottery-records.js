import { ui } from './ui-copy.js';
export const LOTTERY_USER=ui.lottery.天选时刻;
export const MAX_LOTTERY_NOTE=500;
export function validateLotteryNote(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['revision','note'].includes(k))||
    !Number.isSafeInteger(input.revision)||input.revision<0||typeof input.note!=='string'||input.note.length>MAX_LOTTERY_NOTE||/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(input.note))
    throw new Error(ui.lottery.奖品备注无效);
  return {revision:input.revision,note:input.note.trim()};
}
export function lotteryCountLabel(record){
  const count=record.winnerCount??record.winners?.length??0;
  if(record.state==='settling')return ui.lottery.开奖中等待名单;
  return record.expectedWinners===null?ui.lottery.中奖人数待确认(count):
    record.state==='complete'?ui.lottery.中奖人数(count):ui.lottery.中奖名单待补全(count, record.expectedWinners);
}
export const isGiftEvent=event=>event?.type==='gift'||event?.type==='guard';
