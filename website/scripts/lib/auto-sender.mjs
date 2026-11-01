// Embedded in both standalone userscripts by sync-auto-sender.mjs.
// Web Locks and origin storage are shared by documents AND userscript sandboxes.
export function createSharedAutoSender(env = globalThis) {
  const locks = env.navigator?.locks
  let held = null,
    pending = null,
    generation = 0
  const failure = (message) => new Error(message)
  function release() {
    generation++
    held?.release()
    held = null
    pending = null
  }
  async function claim(uid, room) {
    if (!locks?.request)
      throw failure('此浏览器无法协调多个标签页，自动发送已暂停。请使用支持 Web Locks 的浏览器。')
    if (!/^\d{1,24}$/.test(uid) || !/^\d{1,24}$/.test(room))
      throw failure('无法确认当前账号或直播间，自动发送已暂停。')
    const key = `caibao:auto-sender:v1:room:${uid}:${room}`
    if (held?.key === key) return
    if (pending?.key === key) return pending.promise
    release()
    const version = generation
    let ready, reject
    const promise = new Promise((resolve, fail) => {
      ready = resolve
      reject = fail
    })
    pending = { key, promise }
    void locks
      .request(key, { ifAvailable: true }, async (lock) => {
        if (version !== generation) throw failure('自动发送状态已变化，本条已取消。')
        if (!lock)
          throw failure('此账号在这个直播间已有另一个标签页自动发送，请先关闭那里的自动发送。')
        let finish
        const lifetime = new Promise((resolve) => {
          finish = resolve
        })
        held = { key, release: finish }
        ready()
        await lifetime
      })
      .catch(reject)
    try {
      await promise
    } finally {
      if (pending?.promise === promise) pending = null
    }
  }
  async function send({ uid, room, text, isCurrent = () => true }, submit) {
    await claim(uid, room)
    const version = generation
    const reserved = await locks.request(
      `caibao:auto-sender:v1:account:${uid}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) throw failure('此账号的另一个发送请求尚未结束，本条跳过。')
        if (version !== generation || !held || !isCurrent())
          throw failure('自动发送状态已变化，本条已取消。')
        const key = `caibao:auto-sender:v1:history:${uid}`
        let previous
        try {
          previous = JSON.parse(env.localStorage.getItem(key) || '{"lastAt":0,"recent":[]}')
        } catch {
          throw failure('无法读取共享发送记录，自动发送已暂停。')
        }
        if (
          !Number.isFinite(previous?.lastAt) ||
          previous.lastAt < 0 ||
          !Array.isArray(previous.recent) ||
          previous.recent.length > 64 ||
          previous.recent.some((item) => typeof item?.key !== 'string' || !Number.isFinite(item.at))
        )
          throw failure('共享发送记录异常，自动发送已暂停。')
        const now = env.Date.now()
        if (previous.lastAt && now - previous.lastAt < 5000)
          throw failure('此账号距离上次自动发送不足 5 秒，本条跳过。')
        const recent = previous.recent.filter((item) => now - item.at < 15000)
        const fingerprint = `${room}:${text}`
        if (recent.some((item) => item.key === fingerprint))
          throw failure('此直播间 15 秒内已自动发送相同内容，本条跳过。')
        // Reserve BEFORE submission. Ambiguous network failures must retain the
        // cooldown and duplicate guard; no implicit retry or rollback.
        try {
          env.localStorage.setItem(
            key,
            JSON.stringify({
              lastAt: now,
              recent: [...recent.slice(-63), { key: fingerprint, at: now }],
            }),
          )
        } catch {
          throw failure('无法保存共享发送记录，自动发送已暂停。')
        }
        // The atomic lock covers reservation and starting the request, not an
        // unresponsive network promise. The persisted clock protects later sends.
        return { result: submit() }
      },
    )
    return reserved.result
  }
  return { send, release }
}
