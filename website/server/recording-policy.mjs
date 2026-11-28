import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// The standalone website archive ships the same protocol implementation at its root.
const { POLICY_CHANNELS, POLICY_FILES, POLICY_PLATFORMS, policyUid, readRecordingPolicy } =
  await import('../../live-editor/shared/recording-policy.js').catch((error) => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return import('../recording-policy.js')
  })

const adminPath = '/admin/recorder-policy'
const labels = { bilibili: 'B 站', douyin: '抖音', xiaohongshu: '小红书' }
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  )

export async function resolveBilibiliRoom(link, request = fetch) {
  const url = new URL(link)
  const id = /^\/([1-9]\d{0,9})\/?$/.exec(url.pathname)?.[1]
  if (url.origin !== 'https://live.bilibili.com' || url.username || url.password || !id) {
    throw Error('请输入 live.bilibili.com 的完整直播间链接。')
  }
  const query = async (route) => {
    const response = await request('https://api.live.bilibili.com/' + route, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' },
    })
    if (!response.ok) throw Error('B 站查询失败，请稍后重试。')
    const result = await response.json()
    if (result.code !== 0) throw Error('B 站未返回已核对的主播信息。')
    return result.data
  }
  const room = await query('room/v1/Room/room_init?id=' + id)
  const uid = policyUid('bilibili', room?.uid)
  if (!uid || !Number.isSafeInteger(room?.room_id) || room.room_id < 1)
    throw Error('未能核对房间与账号。')
  const anchor = await query('live_user/v1/UserInfo/get_anchor_in_room?roomid=' + room.room_id)
  if (!anchor?.info?.uname || String(anchor.info.uid) !== uid)
    throw Error('B 站返回的房间与主播身份不一致。')
  return {
    platform: 'bilibili',
    uid,
    name: String(anchor.info.uname).slice(0, 100),
    link: 'https://live.bilibili.com/' + room.room_id,
  }
}

function page(policy, preview, message, isError) {
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escape(value)}">`
  const button = (action, label) => `<button name="action" value="${action}">${label}</button>`
  const entries = policy.entries
    .map(
      ({ platform, uid }) => `<li><span>${labels[platform]} · ${escape(uid)}</span>
    <form method="post">${hidden('revision', policy.revision)}${hidden('platform', platform)}${hidden('uid', uid)}
    ${button('review-remove', '解除')}</form></li>`,
    )
    .join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>录包机禁录名单 · 菜包宇宙</title>
    <style>
      :root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;color:#362728;background:#fff5f5}
      body{margin:0;padding:clamp(18px,5vw,52px)}main{max-width:680px;margin:auto}
      header p,p{margin:6px 0;color:#704e50}h1{font-size:clamp(26px,5vw,38px);margin:0}h2{font-size:19px;margin:0 0 12px}
      section{background:#fff;border:1px solid #e9d3d4;border-radius:14px;padding:18px;margin-top:16px}
      label{display:block;margin:9px 0 4px}input:not([type=hidden]),select{box-sizing:border-box;max-width:100%;padding:8px 10px;border:1px solid #c9a4a7;border-radius:8px;font:inherit}
      input:not([type=hidden]){width:100%}button{font:inherit;padding:7px 12px;border:1px solid #a23f48;border-radius:8px;background:#fff;color:#852934;cursor:pointer}
      form>button{margin-top:8px}li form>button{margin:0}button:hover{background:#ffe7e8}a{color:#852934}ul{margin:0;padding:0;list-style:none}
      li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #eee0e0}
      [role=alert]{color:#a02033}code{overflow-wrap:anywhere}
    </style>
    <main><header><p>菜包宇宙</p><h1>录包机禁录名单</h1><p>${policy.channel === 'beta' ? '测试通道' : '正式通道'} · 版本 ${policy.revision}</p></header>
    ${message ? `<p role="${isError ? 'alert' : 'status'}">${escape(message)}</p>` : ''}
    ${
      preview
        ? `<section><h2>${preview.remove ? '确认解除禁录' : '核对主播身份'}</h2>
    <p>${labels[preview.platform]} · ${escape(preview.name)} <code>${escape(preview.uid)}</code></p>
    ${preview.link ? `<p><a href="${escape(preview.link)}" rel="noreferrer">打开直播间</a></p>` : ''}
    <form method="post">${hidden('revision', policy.revision)}${hidden('platform', preview.platform)}${hidden('uid', preview.uid)}${hidden('link', preview.link)}
    ${button(preview.remove ? 'remove' : 'add', preview.remove ? '确认解除并发布' : '确认禁录并发布')} <a href="${adminPath}">取消</a></form></section>`
        : ''
    }
    <section><h2>添加禁录</h2>
    <form method="post">
      <label for="platform">平台</label><select id="platform" name="platform">${POLICY_PLATFORMS.map((p) => `<option value="${p}">${labels[p]}</option>`).join('')}</select>
      <label for="identity">B 站直播链接或主播账号 ID</label><input id="identity" name="identity" required maxlength="512">
      ${button('review-add', '核对主播')}
    </form></section>
    <section><h2>当前名单</h2>${entries ? `<ul>${entries}</ul>` : '<p>当前没有禁录主播。</p>'}</section></main></html>`
}

export async function createPolicyServer({
  directory,
  privateKey,
  origin,
  channel = 'beta',
  request = fetch,
  publicKey,
}) {
  if (!POLICY_CHANNELS.includes(channel)) throw Error('录制规则通道无效。')
  const key = createPrivateKey(privateKey)
  const file = (target) => path.join(directory, POLICY_FILES[target])
  const read = async (target) =>
    readRecordingPolicy(JSON.parse(await fs.readFile(file(target), 'utf8')), target, publicKey)
  const write = async (target, revision, entries) => {
    const data = Buffer.from(
      JSON.stringify({
        schema: 1,
        type: 'caibo-recording-policy',
        channel: target,
        revision,
        entries,
      }),
    )
    const envelope = {
      schema: 1,
      data: data.toString('base64'),
      signature: sign(null, data, key).toString('base64'),
    }
    const verified = readRecordingPolicy(envelope, target, publicKey)
    const temporary = path.join(directory, '.' + POLICY_FILES[target] + '.' + randomUUID())
    try {
      await fs.writeFile(temporary, JSON.stringify(envelope) + '\n', {
        flag: 'wx',
        mode: 0o644,
        flush: true,
      })
      await fs.rename(temporary, file(target))
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return verified
  }
  for (const target of POLICY_CHANNELS) {
    try {
      await read(target)
    } catch (error) {
      if (error.code === 'ENOENT') await write(target, 1, [])
      else throw error
    }
  }

  let pending = Promise.resolve()
  return createServer((req, res) => {
    const send = (code, markup) => {
      res.writeHead(code, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end(markup)
    }
    if (req.url !== adminPath || !['GET', 'POST'].includes(req.method)) {
      send(404, '页面不存在。')
      return
    }
    if (
      req.method === 'POST' &&
      (req.headers.origin !== origin ||
        req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded')
    ) {
      send(403, '请求来源无效。')
      return
    }
    const handle = async () => {
      let policy = await read(channel)
      if (req.method === 'GET') {
        send(200, page(policy))
        return
      }
      let raw = ''
      for await (const chunk of req) {
        raw += chunk.toString('utf8')
        if (raw.length > 4096) {
          send(413, '表单过大。')
          return
        }
      }
      const form = new URLSearchParams(raw),
        action = form.get('action'),
        platform = form.get('platform')
      const uid = policyUid(platform, form.get('uid')),
        link = form.get('link')
      try {
        if (action === 'review-add') {
          const identity = (form.get('identity') ?? '').trim()
          const preview =
            platform === 'bilibili' && identity.startsWith('https://')
              ? await resolveBilibiliRoom(identity, request)
              : { platform, uid: policyUid(platform, identity) }
          if (!preview.uid) throw Error('请输入有效的主播账号 ID。')
          send(200, page(policy, preview))
          return
        }
        if (!uid || !['review-remove', 'remove', 'add'].includes(action)) throw Error('操作无效。')
        if (String(policy.revision) !== form.get('revision'))
          throw Error('名单已更新，请重新核对。')
        const same = (entry) => entry.platform === platform && entry.uid === uid
        const found = policy.entries.some(same)
        if (action === 'review-remove' && found) {
          send(200, page(policy, { platform, uid, remove: true }))
          return
        }
        if (action === 'add' && !found) {
          if (
            link &&
            (platform !== 'bilibili' || (await resolveBilibiliRoom(link, request)).uid !== uid)
          ) {
            throw Error('直播间身份有变化，请重新核对。')
          }
          policy = await write(channel, policy.revision + 1, [...policy.entries, { platform, uid }])
        } else if (action === 'remove' && found) {
          policy = await write(
            channel,
            policy.revision + 1,
            policy.entries.filter((entry) => !same(entry)),
          )
        } else throw Error('该账号的名单状态已变化。')
        send(200, page(policy, null, action === 'add' ? '已发布禁录规则。' : '已发布解除规则。'))
      } catch (error) {
        send(400, page(policy, null, error.message, true))
      }
    }
    const operation = (req.method === 'POST' ? pending : Promise.resolve()).then(handle)
    if (req.method === 'POST') pending = operation.catch(() => {})
    void operation.catch((error) => {
      console.error('Policy request failed:', error.code || error.name)
      if (!res.headersSent) send(500, '暂时无法读取录制规则。')
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.env.CAIBO_POLICY_DIRECTORY
  const keyFile = process.env.CAIBO_POLICY_KEY_FILE
  if (!directory || !keyFile) throw Error('Missing policy directory or signing key file')
  const server = await createPolicyServer({
    directory,
    privateKey: await fs.readFile(keyFile),
    origin: process.env.CAIBO_POLICY_ORIGIN || 'https://caibao.media',
    channel: process.env.CAIBO_POLICY_CHANNEL || 'beta',
  })
  server.listen(8795, '0.0.0.0')
}
