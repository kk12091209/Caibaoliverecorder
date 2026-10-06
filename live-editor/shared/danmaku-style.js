export const DANMAKU_SIZE_STEPS = Object.freeze([0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
export const DEFAULT_DANMAKU_STYLE = Object.freeze({ size: 0.6, opacity: 100 });
export const DANMAKU_STYLE_SETTING = 'danmaku-style';

export function validateDanmakuStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['size', 'opacity'].includes(key)) || !DANMAKU_SIZE_STEPS.includes(value.size) || !Number.isInteger(value.opacity) || value.opacity < 0 || value.opacity > 100) {
    throw new Error('请选择有效的弹幕字号档位和 0～100% 的透明度。');
  }
  return { size: value.size, opacity: value.opacity };
}
export function normalizedDanmakuStyle(value) {
  try { return validateDanmakuStyle(value); } catch { return { ...DEFAULT_DANMAKU_STYLE }; }
}
export function savedDanmakuStyle(store) { return normalizedDanmakuStyle(store.setting(DANMAKU_STYLE_SETTING)); }

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
