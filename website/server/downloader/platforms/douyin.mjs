// Read only data serialized by Douyin. Never evaluate executable page scripts.
export function findDouyinItem(value, id, depth = 0, budget = { left: 100000 }) {
  if (!value || typeof value !== 'object' || depth > 24 || --budget.left < 0) return null
  if (
    String(value.aweme_id || value.awemeId) === String(id) &&
    (value.video || Array.isArray(value.images))
  )
    return value
  for (const child of Object.values(value)) {
    const found = findDouyinItem(child, id, depth + 1, budget)
    if (found) return found
  }
  return null
}
const parse = (text) =>
  JSON.parse(text, (_key, value) => (value === '$undefined' ? undefined : value))
export function douyinScriptItem(scripts, id) {
  let flight = ''
  for (const text of scripts) {
    if (text.length > 12 * 1024 * 1024) continue
    const push = text.match(/^\s*self\.__pace_f\.push\((\[[\s\S]*\])\);?\s*$/)
    if (push) {
      try {
        const data = parse(push[1])
        if (
          data[0] === 1 &&
          typeof data[1] === 'string' &&
          flight.length + data[1].length < 16 * 1024 * 1024
        )
          flight += data[1]
      } catch {}
      continue
    }
    for (const candidate of [
      text,
      text.replace(/^\s*window\._ROUTER_DATA\s*=\s*/, '').replace(/;\s*$/, ''),
    ]) {
      try {
        const found = findDouyinItem(parse(candidate), id)
        if (found) return found
      } catch {}
      if (candidate.startsWith('%7B'))
        try {
          const found = findDouyinItem(parse(decodeURIComponent(candidate)), id)
          if (found) return found
        } catch {}
    }
  }
  for (const line of flight.split('\n')) {
    if (!/^[\da-f]+:[\[{]/i.test(line)) continue
    try {
      const found = findDouyinItem(parse(line.slice(line.indexOf(':') + 1)), id)
      if (found) return found
    } catch {}
  }
  return null
}
