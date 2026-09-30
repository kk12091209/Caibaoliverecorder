export function formatVideoTime(value, milliseconds = false) {
  const number = Number(value);
  const seconds = Number.isFinite(number) ? Math.max(0, number) : 0;
  // Quantize once before splitting fields: floating-point frame stepping can
  // land just below a whole second, so a separately rounded fraction overflows.
  const totalMilliseconds = milliseconds ? Math.round(seconds * 1000) : Math.floor(seconds) * 1000;
  const wholeSeconds = Math.floor(totalMilliseconds / 1000);
  const time = [Math.floor(wholeSeconds / 3600), Math.floor(wholeSeconds / 60) % 60, wholeSeconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
  return time + (milliseconds ? '.' + String(totalMilliseconds % 1000).padStart(3, '0') : '');
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
