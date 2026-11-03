// List navigation uses recorded media seconds only. It never supplies a
// recording duration or writes back a time inferred from chat timestamps.
export function messageTime(value,duration){
  const end=Number.isFinite(duration)&&duration>0?duration:0;
  return Math.max(0,Math.min(end,Number.isFinite(value)?value:0));
}
export function messageWindow(duration,position,follow){
  const end=messageTime(duration,duration),at=messageTime(position,end);
  return follow?{from:Math.max(0,at-60),to:Math.min(end,at+60)}:{from:0,to:end};
}
