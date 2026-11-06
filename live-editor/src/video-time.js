export function formatVideoTime(value, milliseconds = false) {
  const number = Number(value);
  const seconds = Number.isFinite(number) ? Math.max(0, number) : 0;
  // Quantize once before splitting fields: floating-point frame stepping can
  // land just below a whole second, so a separately rounded fraction overflows.
  const totalMilliseconds = Math.round(seconds * 1000);
  const wholeSeconds = milliseconds ? Math.floor(totalMilliseconds / 1000) : Math.round(seconds);
  const time = [Math.floor(wholeSeconds / 3600), Math.floor(wholeSeconds / 60) % 60, wholeSeconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
  return time + (milliseconds ? '.' + String(totalMilliseconds % 1000).padStart(3, '0') : '');
}

// Shown durations use the same rounded seconds as the start and end labels,
// so 00:00:07 → 00:00:13 reads as 6 seconds rather than the truncated raw gap.
export function displayedSpan(start, end) {
  const seconds = value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  };
  return Math.max(0, seconds(end) - seconds(start));
}

// An exclusive clip end can be exactly before a stream gap. Keep the marker,
// but preview the last frame of that source instead of requesting empty media.
export function markPreviewPosition(seconds,sources) {
  if(sources.some(source=>seconds>=source.start&&seconds<source.start+source.duration))return seconds;
  const source=sources.find(source=>source.duration>0&&Math.abs(seconds-source.start-source.duration)<=.000001);
  if(!source)return seconds;
  const rate=Number(source.metadata?.fps),fps=Number.isFinite(rate)&&rate>0?rate:30;
  return Math.max(source.start,source.start+source.duration-1/fps);
}

export function videoFrameRate(value) {
  return Number.isFinite(value)&&value>0?value:30;
}

// Display a frame within its elapsed second, including fractional rates such
// as 29.97 fps. The label never changes the underlying media position.
export function formatFrameTime(value, fps) {
  const rate=videoFrameRate(fps),time=Number.isFinite(value)?Math.max(0,value):0;
  const frame=Math.round(time*rate),second=Math.floor(frame/rate+1e-9);
  const within=frame-Math.ceil(second*rate-1e-8);
  return formatVideoTime(second)+':'+String(within).padStart(2,'0');
}

export function frameTimePosition(second, frame, fps) {
  const rate=videoFrameRate(fps),first=Math.ceil(second*rate-1e-8);
  if(!Number.isSafeInteger(second)||second<0||!Number.isSafeInteger(frame)||frame<0||first+frame>=Math.ceil((second+1)*rate-1e-8))return NaN;
  return (first+frame)/rate;
}

export function formatFrameDuration(value, fps) {
  const rate=videoFrameRate(fps);
  return value>0&&Math.round(value*rate)===0?'< '+formatFrameTime(1/rate,rate):formatFrameTime(value,rate);
}

// Seek to a decodable frame at the indexed tail; the exclusive edge can
// contain only audio or no frame, so leave at most one frame of headroom.
export function latestPreviewPosition(sources, duration) {
  let latest=null,end=0;
  for(const source of sources){
    const stop=Math.min(duration,source.start+source.duration);
    if(stop>source.start&&stop>end){latest=source;end=stop;}
  }
  return latest?Math.max(latest.start,end-1/videoFrameRate(latest.metadata?.fps)):null;
}
