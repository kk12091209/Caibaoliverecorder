import {giftMessages} from './gifts.js';
import {lotteryMessages} from './lottery-records.js';
import {compareFeed,cursorFor,validateCursor} from './feed-cursor.js';
import {messageTime} from '../shared/message-navigation.js';

export function messageFeed(store,id,{search='',sender=null,gifts=false,onlyGifts=false,style,from=0,to,at,cursor,direction='after',limit=300}={}) {
  const duration=messageTime(store.session(id)?.duration,store.session(id)?.duration);
  to??=duration;
  if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from||at!==undefined&&(!Number.isFinite(at)||at<0))throw new Error('弹幕列表时间范围无效。');
  search=search.trim();
  if(search){
    from=0;
    to=duration;
    gifts=true;
    onlyGifts=false;
    sender=null;
    style=undefined;
  }
  from=messageTime(from,duration);to=messageTime(to,duration);
  if(at!==undefined)at=Math.max(from,Math.min(to,at));
  if(!['before','after'].includes(direction))throw new Error('列表翻页方向无效。');
  if(cursor)cursor=validateCursor(cursor);
  if(cursor&&(cursor.time<from||cursor.time>to))throw new Error('列表分页位置超出已录制范围。');
  limit=Math.min(300,Math.max(1,limit));
  const read=(page,count)=>{
    const options={from,to,search,style,limit:count,page};
    const rows=[...(!onlyGifts?store.messages(id,from,to,search,count,undefined,undefined,sender,page):[]),
      ...(gifts&&!sender?[...giftMessages(store,id,{...options,includeSuperChat:true}),...lotteryMessages(store,id,options)]:[])];
    rows.sort(compareFeed);
    return page.direction==='before'?rows.slice(-count):rows.slice(0,count);
  };
  let rows,hasBefore=false,hasAfter=false;
  if(!cursor&&Number.isFinite(at)&&at>0){
    const pivot={time:at,key:''},previous=read({direction:'before',cursor:pivot},Math.floor(limit*.75)+1),next=read({direction:'after',cursor:pivot},Math.ceil(limit*.25)+1);
    hasBefore=previous.length>Math.floor(limit*.75);hasAfter=next.length>Math.ceil(limit*.25);
    rows=[...previous.slice(-Math.floor(limit*.75)),...next.slice(0,Math.ceil(limit*.25))];
  }else{
    const found=read({direction,cursor},limit+1),more=found.length>limit;
    rows=direction==='before'?found.slice(-limit):found.slice(0,limit);
    hasBefore=direction==='before'?more:!!cursor;
    hasAfter=direction==='after'?more:!!cursor;
  }
  return {rows,before:cursorFor(rows[0]),after:cursorFor(rows.at(-1)),hasBefore,hasAfter,from,to};
}
