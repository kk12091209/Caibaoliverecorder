export const LOTTERY_USER='天选时刻';
export const MAX_LOTTERY_NOTE=500;
export function validateLotteryNote(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['revision','note'].includes(k))||
    !Number.isSafeInteger(input.revision)||input.revision<0||typeof input.note!=='string'||input.note.length>MAX_LOTTERY_NOTE||/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(input.note))
    throw new Error('奖品备注最多 500 个字符，且不能包含换行；请保留当前记录版本。');
  return {revision:input.revision,note:input.note.trim()};
}
export function lotteryCountLabel(record){
  const count=record.winnerCount??record.winners?.length??0;
  if(record.state==='settling')return '开奖中，等待名单';
  return record.expectedWinners===null?`已收到 ${count} 位中奖用户，人数待确认`:
    record.state==='complete'?`共 ${count} 人中奖`:`名单待补全：${count} / ${record.expectedWinners} 人`;
}
export const isGiftEvent=event=>event?.type==='gift'||event?.type==='guard';
