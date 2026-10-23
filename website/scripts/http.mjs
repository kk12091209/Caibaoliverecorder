import { setTimeout as sleep } from 'node:timers/promises'

const transientCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const transientStatuses = new Set([408, 429, 500, 502, 503, 504])

function isTransient(error) {
  if (!error) return false
  return (
    error.name === 'TimeoutError' ||
    transientCodes.has(error.code) ||
    isTransient(error.cause) ||
    (Array.isArray(error.errors) && error.errors.some(isTransient))
  )
}

// Retry only transport errors and temporary HTTP responses. Each attempt gets a new timeout.
export async function fetchWithRetry(
  url,
  { timeoutMs = 30000, ...options } = {},
  { fetchImpl = fetch, sleepImpl = sleep, attempts = 3 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      if (attempt === attempts || !isTransient(error)) throw error
      await sleepImpl(1000 * 2 ** (attempt - 1))
      continue
    }
    if (attempt === attempts || !transientStatuses.has(response.status)) return response
    const retryAfter = Number(response.headers.get('retry-after'))
    await response.body?.cancel()
    await sleepImpl(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : 1000 * 2 ** (attempt - 1),
    )
  }
  throw new Error('No HTTP attempt was made')
}

export function networkErrorCode(error) {
  const code =
    error?.code ||
    (error?.cause ? networkErrorCode(error.cause) : undefined) ||
    error?.errors?.map(networkErrorCode).find(Boolean)
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined
}
