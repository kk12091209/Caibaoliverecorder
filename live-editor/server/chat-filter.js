const MARKER = '表情包_';
const MAX_MESSAGE_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 256;

// This recognizes the recorder's visible placeholder shape, not an authoritative
// platform message type. Ambiguous text, mixed prose and oversized input stay.
export function isStickerPlaceholder(text) {
  if (typeof text !== 'string' || !text.length || text.length > MAX_MESSAGE_LENGTH ||
      /[\r\n\v\f\u0085\u2028\u2029]/u.test(text)) return false;
  let offset = 0, count = 0;
  while (offset < text.length) {
    while (offset < text.length && /\s/u.test(text[offset])) offset++;
    if (offset === text.length) break;
    if (text[offset] !== '[') return false;
    const end = text.indexOf(']', offset + 1);
    if (end < 0 || end - offset + 1 > MAX_TOKEN_LENGTH) return false;
    const token = text.slice(offset + 1, end);
    if (token.includes('[')) return false;
    const marker = token.lastIndexOf(MARKER);
    if (marker <= 0 || !token.slice(0, marker).trim() || !token.slice(marker + MARKER.length).trim()) return false;
    count++;
    offset = end + 1;
  }
  return count > 0;
}
