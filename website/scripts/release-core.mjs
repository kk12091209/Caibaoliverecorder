import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const safeId = /^[a-z0-9][a-z0-9-]*$/
export function versionOf(tag) {
  if (typeof tag !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error('仅接受 major.minor.patch 正式版本')
  }
  return tag.replace(/^v/, '')
}

export function compareVersions(a, b) {
  const left = versionOf(a).split('.').map(BigInt)
  const right = versionOf(b).split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}

export function validateConfig(config) {
  if (config.schemaVersion !== 1 || !Array.isArray(config.products) || !config.products.length)
    throw new Error('产品配置无效')
  const slugs = new Set()
  for (const product of config.products) {
    if (!safeId.test(product.slug) || slugs.has(product.slug)) throw new Error('产品标识无效或重复')
    slugs.add(product.slug)
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(product.repository))
      throw new Error('GitHub 仓库格式无效')
    if (!Array.isArray(product.files) || !product.files.length) throw new Error('必须配置安装包')
    if (product.desktopUpdate) versionOf(product.desktopUpdate.fromVersion)
    const ids = new Set()
    for (const item of [...product.files, ...(product.sources || [])]) {
      if (!safeId.test(item.id) || ids.has(item.id)) throw new Error('文件标识无效或重复')
      ids.add(item.id)
      if (
        typeof item.name !== 'string' ||
        !item.name.includes('{version}') ||
        !/^[A-Za-z0-9_.{}-]+$/.test(item.name)
      )
        throw new Error('文件名模板无效')
    }
    for (const item of product.files) {
      if (!['windows', 'macos'].includes(item.platform) || !['x64', 'arm64'].includes(item.arch))
        throw new Error('系统或架构无效')
    }
  }
  return config
}

export function planRelease(product, release, baseUrl, previous) {
  if (release.draft || release.prerelease) throw new Error('不发布草稿或预发布版')
  const version = versionOf(release.tag_name)
  if (previous && compareVersions(version, previous.version) < 0) throw new Error('拒绝自动降级')
  const base = new URL(baseUrl)
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('下载地址必须是 HTTPS 域名')
  if (!Number.isFinite(Date.parse(release.published_at))) throw new Error('发布时间无效')
  const pick = (spec) => {
    const name = spec.name.replaceAll('{version}', version)
    const matches = release.assets.filter((asset) => asset.name === name)
    if (matches.length !== 1) throw new Error(`缺少或重复文件：${name}`)
    const asset = matches[0]
    if (
      asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !Number.isSafeInteger(asset.id)
    )
      throw new Error(`文件尚未就绪：${name}`)
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`缺少 SHA-256：${name}`)
    const key = `${product.slug}/${version}/${name}`
    return {
      id: spec.id,
      ...(spec.platform ? { platform: spec.platform, arch: spec.arch } : {}),
      name,
      size: asset.size,
      sha256: asset.digest.slice(7),
      url: new URL(key, base).href,
      key,
      assetId: asset.id,
    }
  }
  const files = product.files.map(pick)
  const sources = (product.sources || []).map(pick)
  const desktopUpdate =
    product.desktopUpdate && compareVersions(version, product.desktopUpdate.fromVersion) >= 0
      ? pick({ id: 'desktop-update', name: 'caibao-update.json' })
      : null
  if (previous && compareVersions(version, previous.version) === 0) {
    const old = [...previous.files, ...(previous.sources || [])]
    for (const file of [...files, ...sources]) {
      const prior = old.find((item) => item.id === file.id)
      if (prior && (prior.sha256 !== file.sha256 || prior.size !== file.size))
        throw new Error(`已发布版本的文件发生变化：${file.name}；请发布新版本`)
    }
  }
  const publishFile = ({ key, assetId, ...file }) => file
  return {
    assets: [...files, ...sources, ...(desktopUpdate ? [desktopUpdate] : [])],
    sourceRevision: release.target_commitish,
    publicRelease: {
      version: `v${version}`,
      publishedAt: release.published_at,
      ...(product.publicRepository
        ? {
            releaseUrl: `https://github.com/${product.repository}/releases/tag/${release.tag_name}`,
          }
        : {}),
      notes: product.publishReleaseNotes === true ? String(release.body || '').slice(0, 20000) : '',
      files: files.map(publishFile),
      sources: sources.map(publishFile),
      ...(desktopUpdate ? { desktopUpdate: publishFile(desktopUpdate) } : {}),
    },
  }
}

export async function verifyStream(body, destination, expected) {
  let size = 0
  const sha = createHash('sha256')
  const md5 = createHash('md5')
  const checker = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (size > expected.size) return callback(new Error('下载文件超过声明大小'))
      sha.update(chunk)
      md5.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(body, checker, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    if (size !== expected.size || sha.digest('hex') !== expected.sha256)
      throw new Error('下载文件大小或 SHA-256 校验失败')
    return { md5: md5.digest('base64') }
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

export async function verifyFile(path, expected) {
  let size = 0
  const sha = createHash('sha256')
  const md5 = createHash('md5')
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    sha.update(chunk)
    md5.update(chunk)
  }
  if (size !== expected.size || sha.digest('hex') !== expected.sha256)
    throw new Error('缓存文件校验失败')
  return { md5: md5.digest('base64') }
}

export async function readCatalog(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    if (
      data.schemaVersion !== 1 ||
      !data.products ||
      typeof data.products !== 'object' ||
      Array.isArray(data.products)
    )
      throw new Error('现有版本清单损坏，拒绝覆盖')
    return data
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, products: {} }
    throw error
  }
}

export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

// A product becomes visible only after every file (including required sources) is verified.
export async function publishProduct(plan, ensureAsset, verifyPublicAsset = async () => {}) {
  for (const asset of plan.assets) await ensureAsset(asset)
  for (const asset of plan.assets) await verifyPublicAsset(asset)
  return plan.publicRelease
}

export async function cachedAsset(directory, asset, download) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${asset.sha256}-${asset.name}`)
  try {
    return { path, ...(await verifyFile(path, asset)) }
  } catch (error) {
    if (error.code !== 'ENOENT') await rm(path, { force: true })
  }
  const temp = `${path}.${randomUUID()}.part`
  const digest = await download(temp)
  await rename(temp, path)
  return { path, ...digest }
}
