// Fresh regex per read: each caller owns its scan cursor and byte offsets.
export function chatEventPattern() {
  return /<(d|sc|gift|guard|density)\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
}

export const decodeXML = s => s.replace(/&#x([0-9a-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi, (_, x, d, n) => x || d ? String.fromCodePoint(Math.min(0x10ffff, parseInt(x || d, x ? 16 : 10))) : ({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'}[n] || ''));

export function xmlAttributes(text) {
  const attributes = {};
  for (const [, name, value] of text.matchAll(/([\w-]+)="([^"]*)"/g)) {
    attributes[name] = decodeXML(value);
  }
  return attributes;
}
