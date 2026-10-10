export const DANMAKU_SIZE_STEPS = Object.freeze([0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
export const DANMAKU_SPEED_STEPS = Object.freeze(Array.from({ length: 16 }, (_, index) => (index + 5) / 10));
export const DEFAULT_DANMAKU_STYLE = Object.freeze({ size: 0.6, opacity: 100, speed: 1, fps: 60 });
export const DANMAKU_STYLE_SETTING = 'danmaku-style';

export function validateDanmakuStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['size', 'opacity', 'speed', 'fps'].includes(key)) || !DANMAKU_SIZE_STEPS.includes(value.size) || !Number.isInteger(value.opacity) || value.opacity < 0 || value.opacity > 100) {
    throw new Error('请选择有效的弹幕字号档位和 0～100% 的透明度。');
  }
  // Existing settings and queued jobs predate speed / frame-rate selection.
  const speed = value.speed === undefined ? 1 : value.speed, fps = value.fps === undefined ? 60 : value.fps;
  if (!DANMAKU_SPEED_STEPS.includes(speed) || ![30, 60].includes(fps)) throw new Error('弹幕速度须为 0.5～2.0（步长 0.1），帧率须为 30 或 60 帧。');
  return { size: value.size, opacity: value.opacity, speed, fps };
}
export function normalizedDanmakuStyle(value) {
  try { return validateDanmakuStyle(value); } catch { return { ...DEFAULT_DANMAKU_STYLE }; }
}
export function savedDanmakuStyle(store) { return normalizedDanmakuStyle(store.setting(DANMAKU_STYLE_SETTING)); }
export function danmakuDuration(value) { return 6 / normalizedDanmakuStyle(value).speed; }

// Level 0.6 preserves the previous export size, including its rounding at each
// source resolution. Browser previews use source pixels before scaling to fit.
export function danmakuGeometry(height, value) {
  const style = normalizedDanmakuStyle(value);
  const size = Number((Math.max(20, Math.round(height / 24)) * 2 / 3 * style.size / 0.6).toFixed(3));
  const minimumPitch = Math.ceil(size * 1.4 + 8);
  const lanes = Math.max(1, Math.floor((height - 40) / minimumPitch));
  // Spread the available rows across the whole image, including when a large
  // font leaves only two rows. Keep room for glyph overhang and its outline.
  const glyphHeight = size * 1.4 + 4;
  const top = lanes > 1 ? 20 : Math.max(0, (height - glyphHeight) / 2);
  const lineHeight = lanes > 1 ? Number(((height - top * 2 - glyphHeight) / (lanes - 1)).toFixed(3)) : minimumPitch;
  return { size, lineHeight, top, lanes, opacity: style.opacity / 100 };
}
export function assOpacity(value, originalAlpha = 0) {
  return Math.round(255 - (255 - originalAlpha) * normalizedDanmakuStyle(value).opacity / 100).toString(16).padStart(2, '0').toUpperCase();
}
