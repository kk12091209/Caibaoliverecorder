import COS from 'cos-nodejs-sdk-v5'
import { fetchWithRetry, networkErrorCode } from './http.mjs'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createSign } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { verifyDesktopUpdate } from './desktop-update.mjs'
import { fileURLToPath } from 'node:url'
import {
  atomicJson,
  cachedAsset,
  planRelease,
  publishProduct,
  readCatalog,
  validateConfig,
  verifyStream,
} from './release-core.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = validateConfig(
  JSON.parse(await readFile(process.env.SYNC_CONFIG || join(root, 'deploy/products.json'), 'utf8')),
)
const dryRun = process.argv.includes('--dry-run')
const stateDir = resolve(process.env.SYNC_STATE_DIR || join(root, '.release-state'))
const catalogPath = resolve(
  process.env.RELEASE_CATALOG || join(root, 'public/releases/catalog.json'),
)
const baseUrl = process.env.DOWNLOAD_BASE_URL || 'https://download.caibao.media'
const log = (event, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))

async function api(path, token, options = {}) {
  const response = await fetchWithRetry(`https://api.github.com${path}`, {
    ...options,
    redirect: 'error',
    timeoutMs: 30000,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'caibao-release-sync',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!response.ok)
    throw new Error(
      `GitHub HTTP ${response.status}${response.headers.get('retry-after') ? `，稍后重试 (${response.headers.get('retry-after')}s)` : ''}`,
    )
  return response.json()
}

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const {
    GITHUB_APP_ID: appId,
    GITHUB_INSTALLATION_ID: installationId,
    GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
  } = process.env
  if (!appId && !installationId && !keyFile) return ''
  if (!/^\d+$/.test(appId || '') || !/^\d+$/.test(installationId || '') || !keyFile)
    throw new Error('GitHub App 配置不完整')
  const now = Math.floor(Date.now() / 1000)
  const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url')
  const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`
  const signature = createSign('RSA-SHA256')
    .update(data)
    .sign(await readFile(keyFile), 'base64url')
  const result = await api(
    `/app/installations/${installationId}/access_tokens`,
    `${data}.${signature}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositories: [...new Set(config.products.map((p) => p.repository.split('/')[1]))],
        permissions: { contents: 'read' },
      }),
    },
  )
  return result.token
}

async function downloadAsset(product, asset, token, destination) {
  let url = new URL(
    `https://api.github.com/repos/${product.repository}/releases/assets/${asset.assetId}`,
  )
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetchWithRetry(url, {
      redirect: 'manual',
      timeoutMs: 15 * 60 * 1000,
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'caibao-release-sync',
        ...(url.hostname === 'api.github.com' && token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('GitHub 下载重定向缺少地址')
      url = new URL(location, url)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        ![
          'api.github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'github.com',
        ].includes(url.hostname)
      )
        throw new Error('拒绝非 GitHub 下载域名')
      continue
    }
    if (!response.ok || !response.body) throw new Error(`安装包下载失败 HTTP ${response.status}`)
    return verifyStream(response.body, destination, asset)
  }
  throw new Error('下载重定向过多')
}

function storage() {
  const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION = 'ap-singapore' } = process.env
  if (
    !COS_SECRET_ID ||
    !COS_SECRET_KEY ||
    !COS_BUCKET ||
    !/^[a-z0-9-]+-\d+$/.test(COS_BUCKET) ||
    !/^[a-z]+-[a-z0-9]+$/.test(COS_REGION)
  )
    throw new Error('请配置 COS 凭据、完整桶名和地域')
  const cos = new COS({
    SecretId: COS_SECRET_ID,
    SecretKey: COS_SECRET_KEY,
    Protocol: 'https:',
    Timeout: 120000,
  })
  const params = { Bucket: COS_BUCKET, Region: COS_REGION }
  return {
    async head(asset) {
      try {
        return await cos.headObject({ ...params, Key: asset.key })
      } catch (error) {
        if (error.statusCode === 404) return null
        throw new Error(`COS HEAD 失败 (${error.statusCode || error.code || 'network'})`)
      }
    },
    async put(asset, file) {
      try {
        await cos.putObject({
          ...params,
          Key: asset.key,
          Body: createReadStream(file.path),
          ContentLength: asset.size,
          ContentType: 'application/octet-stream',
          ContentDisposition: `attachment; filename="${asset.name}"`,
          CacheControl: 'public, max-age=31536000, immutable',
          Headers: {
            'Content-MD5': file.md5,
            'x-cos-meta-sha256': asset.sha256,
            'x-cos-forbid-overwrite': 'true',
          },
        })
      } catch (error) {
        throw new Error(`COS 上传失败 (${error.statusCode || error.code || 'network'})`)
      }
    },
  }
}

function verifyHead(result, asset) {
  const headers = Object.fromEntries(
    Object.entries(result.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  if (
    Number(headers['content-length']) !== asset.size ||
    headers['x-cos-meta-sha256'] !== asset.sha256
  )
    throw new Error(`COS 文件校验失败：${asset.name}`)
}

async function verifyPublic(asset) {
  let response = await fetchWithRetry(asset.url, {
    method: 'HEAD',
    redirect: 'manual',
    timeoutMs: 30000,
  })
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    const expected = `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION || 'ap-singapore'}.myqcloud.com/${asset.key}`
    if (location !== expected) throw new Error(`下载跳转目标不正确：${asset.name}`)
    response = await fetchWithRetry(location, {
      method: 'HEAD',
      redirect: 'error',
      timeoutMs: 30000,
    })
  }
  if (!response.ok || Number(response.headers.get('content-length')) !== asset.size)
    throw new Error(`公开下载地址尚不可用：${asset.name}`)
}

try {
  if (!dryRun) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
  }
  const token = await githubToken()
  const catalog = await readCatalog(catalogPath)
  const store = dryRun ? null : storage()
  let changed = false
  let failures = 0
  for (const product of config.products) {
    try {
      const release = await api(`/repos/${product.repository}/releases/latest`, token)
      const plan = planRelease(product, release, baseUrl, catalog.products[product.slug])
      if (dryRun) {
        log('plan', {
          product: product.slug,
          version: plan.publicRelease.version,
          assets: plan.assets.map((a) => ({
            name: a.name,
            size: a.size,
            sha256: a.sha256,
          })),
        })
        continue
      }
      let desktopEnvelope
      const published = await publishProduct(
        plan,
        async (asset) => {
          const existing = await store.head(asset)
          if (existing) verifyHead(existing, asset)
          if (!existing || asset.id === 'desktop-update') {
            if (asset.id === 'desktop-update' && asset.size > 131072)
              throw new Error('桌面更新清单过大')
            const file = await cachedAsset(join(stateDir, 'cache'), asset, (path) =>
              downloadAsset(product, asset, token, path),
            )
            if (asset.id === 'desktop-update') {
              desktopEnvelope = JSON.parse(await readFile(file.path, 'utf8'))
              verifyDesktopUpdate(desktopEnvelope, plan)
            }
            if (!existing) {
              log('upload-start', { product: product.slug, name: asset.name })
              await store.put(asset, file)
              verifyHead(await store.head(asset), asset)
            }
            await rm(file.path, { force: true })
          }
          log('storage-verified', { product: product.slug, name: asset.name })
        },
        async (asset) => {
          log('public-download-check', { product: product.slug, name: asset.name })
          try {
            await verifyPublic(asset)
          } catch (error) {
            throw new Error(`公开下载校验失败：${asset.name}`, { cause: error })
          }
        },
      )
      if (desktopEnvelope)
        await atomicJson(join(dirname(catalogPath), `${product.slug}-update.json`), desktopEnvelope)
      if (JSON.stringify(catalog.products[product.slug]) !== JSON.stringify(published)) {
        catalog.products[product.slug] = published
        changed = true
      }
      log('verified', { product: product.slug, version: published.version })
    } catch (error) {
      failures++
      log('failed', {
        product: product.slug,
        message: error.message,
        code: networkErrorCode(error),
      })
    }
  }
  if (changed) {
    const previous = await readCatalog(catalogPath)
    if (Object.keys(previous.products).length)
      await atomicJson(join(stateDir, 'previous-catalog.json'), previous)
    catalog.generatedAt = new Date().toISOString()
    await atomicJson(catalogPath, catalog)
    log('catalog-published')
  }
  if (failures) process.exitCode = 1
} catch (error) {
  log('failed', { message: error.message, code: networkErrorCode(error) })
  process.exitCode = 1
}
