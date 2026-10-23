const api = 'https://api.bilibili.com'
const unavailable = '该 B 站投稿不存在或当前不可公开访问。'
const busy = 'B 站暂时限制了视频信息访问，请稍后重新解析。'
const retryableCodes = new Set([-352, -412, -500, -509])

function pagesValid(pages) {
  return (
    Array.isArray(pages) &&
    pages.length > 0 &&
    pages.every(
      (p, i) =>
        p &&
        p.page === i + 1 &&
        Number.isSafeInteger(p.cid) &&
        p.cid > 0 &&
        typeof p.part === 'string' &&
        Number.isFinite(p.duration) &&
        p.duration >= 0,
    )
  )
}
function checkCode(response) {
  if (response?.code === 0) return
  if (retryableCodes.has(response?.code)) throw Object.assign(new Error(busy), { retryable: true })
  // Do not interpret deleted, private or login-required posts as a transient
  // metadata outage, or try another endpoint to recover restricted content.
  throw Object.assign(new Error(unavailable), { terminal: true })
}

export async function bilibiliMetadata(bvid, { requestJson, signal }) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('B 站视频编号无效。')
  const options = { signal, headers: { Referer: 'https://www.bilibili.com/' } }
  for (const endpoint of ['/x/web-interface/wbi/view', '/x/web-interface/view']) {
    signal?.throwIfAborted()
    try {
      const response = await requestJson(`${api}${endpoint}?bvid=${bvid}`, options)
      signal?.throwIfAborted()
      checkCode(response)
      const data = response.data
      if (data?.bvid !== bvid || !pagesValid(data.pages))
        throw Object.assign(new Error('B 站返回的视频信息不完整，请重新解析。'), {
          terminal: true,
        })
      return data
    } catch (error) {
      signal?.throwIfAborted()
      if (error.terminal) throw error
      if ([401, 403, 404].includes(error.upstreamStatus)) throw new Error(unavailable)
    }
  }
  // A public pagelist is independent of the temporarily unavailable view API.
  // It supplies the exact CIDs, order and durations for this BV; playback still
  // goes through the existing anonymous highest-quality stream selection.
  signal?.throwIfAborted()
  let response
  try {
    response = await requestJson(`${api}/x/player/pagelist?bvid=${bvid}`, options)
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error([401, 403, 404].includes(error.upstreamStatus) ? unavailable : busy)
  }
  signal?.throwIfAborted()
  checkCode(response)
  const pages = response.data
  if (!pagesValid(pages)) throw new Error('B 站返回的分 P 信息不完整，请重新解析。')
  return {
    bvid,
    pages,
    title: pages.length === 1 ? pages[0].part || `B 站视频 ${bvid}` : `B 站投稿 ${bvid}`,
    pic: pages[0].first_frame || '',
    owner: null,
  }
}
