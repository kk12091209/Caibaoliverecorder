// Keyset pagination: time alone is not unique during busy seconds. Keep SQL
// and JS ordering identical, including ties across chat, gifts and lotteries.
export const feedKey = row => `${row.type==='d'?'d':row.type==='lottery'?'l':'g'}:${row.id}`;
export const compareFeed = (a,b) => a.time-b.time || (feedKey(a)<feedKey(b)?-1:feedKey(a)>feedKey(b)?1:0);
export const cursorFor = row => row ? {time:row.time,key:feedKey(row)} : null;
export function validateCursor(value) {
  if(!value||!Number.isFinite(value.time)||value.time<0||typeof value.key!=='string'||value.key.length>220||!/^([dgl]:|$)/.test(value.key))throw new Error('列表分页位置无效。');
  return {time:value.time,key:value.key};
}
export function cursorFilter(kind,page,args,table='') {
  if(!page?.cursor)return '';
  const cursor=validateCursor(page.cursor),op=page.direction==='before'?'<':'>';
  args.push(cursor.time,cursor.time,cursor.time,cursor.key);
  const p=table?table+'.':'';
  return ` AND ${p}time ${op}= ? AND (${p}time ${op} ? OR (${p}time = ? AND ('${kind}:' || ${p}id) ${op} ?))`;
}
