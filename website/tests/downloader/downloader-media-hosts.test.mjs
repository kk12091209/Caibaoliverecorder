import test from 'node:test'
import assert from 'node:assert/strict'
import { approvedUrl, permittedAddress } from '../../server/downloader/infrastructure/network.mjs'
import {
  shareUrl,
  douyinResult,
  PlatformResolver,
} from '../../server/downloader/platforms/resolver.mjs'

// Operator families from the upstream media-domain inventory, plus the
// aweme.snssdk.com redirect observed for work 7694628910541808753. These are
// policy fixtures; only that work's v5 redirect is a live-download assertion.
const douyinHosts = [
  'v3-dy-o.zjcdn.com',
  'v5-dy-ov-experiment.zjcdn.com',
  'v26-dy-o.zjcdn.com',
  'v99-dy-ov-new-region.zjcdn.com',
  'v9-v2-mps-cdn.douyinvod.com',
  'v26-web.douyinvod.com',
  'v11-weba.douyinvod.com',
  'v3.idouyinvod.com',
  'v3.douyincdn.com',
  'p3-pc-sign.douyinpic.com',
  'p11-webcast-sign.douyinpic.com',
  'sf11-cdn-tos.douyinstatic.com',
  'p3.byteimg.com',
  'p3.ibyteimg.com',
  'p3.pstatp.com',
  'v3.amemv.com',
]
const bilibiliHosts = [
  'upos-sz-mirrorcosov.bilivideo.com',
  'upos-hz-mirrorakam.akamaized.net',
  'cn-gotcha204.bilivideo.com',
  'node.mcdn.bilivideo.cn',
  'i0.hdslb.com',
  'i2.hdslb.com',
  'i0.biliimg.com',
  'node.acgvideo.com',
]

test('Douyin media families accept varying node numbers, regions and experiment labels', () => {
  for (const host of douyinHosts) {
    assert.equal(approvedUrl(`https://${host}/video`).hostname, host)
    assert.equal(approvedUrl(`https://${host.toUpperCase()}/video`).hostname, host)
  }
})

test('Bilibili media families retain domestic edges and the exact overseas Akamai host', () => {
  for (const host of bilibiliHosts)
    assert.equal(approvedUrl(`https://${host}/video`).hostname, host)
  for (const host of [
    'akamaized.net',
    'other.akamaized.net',
    'child.upos-hz-mirrorakam.akamaized.net',
  ])
    assert.throws(() => approvedUrl(`https://${host}/video`), { code: 'UNSUPPORTED_MEDIA_HOST' })
})

test('CDN coverage never accepts lookalike or suffix-spoofed hosts', () => {
  for (const host of [...douyinHosts, ...bilibiliHosts, 'zjcdn.com', 'douyin.com'])
    for (const fake of [
      `${host}.evil.example`,
      `${host}-evil.example`,
      `evil${host.split('.').slice(-2).join('.')}`,
    ])
      assert.throws(() => approvedUrl(`https://${fake}/video`), { code: 'UNSUPPORTED_MEDIA_HOST' })
})

test('expanded CDN coverage retains protocol, credential, port and IP checks', () => {
  for (const value of [
    'file://v5-dy-ov-experiment.zjcdn.com/video',
    'ftp://v5-dy-ov-experiment.zjcdn.com/video',
    'https://v5-dy-ov-experiment.zjcdn.com:444/video',
    'https://user:secret@v5-dy-ov-experiment.zjcdn.com/video',
    'http://127.0.0.1/video',
    'https://2130706433/video',
    'https://0x7f000001/video',
    'https://[::1]/video',
    'https://[::ffff:8.8.8.8]/video',
  ])
    assert.throws(() => approvedUrl(value))
  for (const [address, family] of [
    ['127.0.0.1', 4],
    ['10.0.0.1', 4],
    ['169.254.169.254', 4],
    ['192.168.1.1', 4],
    ['172.16.0.1', 4],
    ['100.64.0.1', 4],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['::ffff:8.8.8.8', 6],
  ])
    assert.equal(permittedAddress(address, family), false)
})

test('accepting a CDN for media never turns it into a supported share-link input', () => {
  for (const host of [...douyinHosts, ...bilibiliHosts])
    assert.throws(() => shareUrl(`https://${host}/video/7694628910541808753`))
  assert.equal(
    shareUrl('6.12 复制打开抖音 https://v.douyin.com/oCJjf3mP8WA/ h@B.GI :4pm').href,
    'https://v.douyin.com/oCJjf3mP8WA/',
  )
})

test('direct Douyin CDN alternatives survive parsing in source order', () => {
  const urls = ['https://v5-dy-ov-experiment.zjcdn.com/video', 'https://v26-dy-o.zjcdn.com/backup']
  const result = douyinResult({
    aweme_id: '7694628910541808753',
    video: { width: 1440, height: 2560, play_addr: { url_list: urls } },
  })
  assert.deepEqual(result.assets[0].urls, urls)
  assert.equal(result.assets[0].width, 1440)
})

test('Bilibili retains overseas primary and domestic backup streams together', async () => {
  const resolver = new PlatformResolver({
    requestJson: async () => ({
      code: 0,
      data: {
        dash: {
          video: [
            {
              id: 80,
              width: 1920,
              height: 1080,
              baseUrl: 'https://upos-hz-mirrorakam.akamaized.net/video',
              backupUrl: ['https://upos-sz-mirrorcosov.bilivideo.com/backup'],
            },
          ],
          audio: [{ baseUrl: 'https://upos-hz-mirrorakam.akamaized.net/audio' }],
        },
      },
    }),
  })
  try {
    const sources = await resolver.bilibiliStreams(
      { id: 'BV1dELb62EBy', url: 'https://www.bilibili.com/video/BV1dELb62EBy/' },
      { cid: 1 },
    )
    assert.deepEqual(sources.video, [
      'https://upos-hz-mirrorakam.akamaized.net/video',
      'https://upos-sz-mirrorcosov.bilivideo.com/backup',
    ])
    assert.deepEqual(sources.audio, ['https://upos-hz-mirrorakam.akamaized.net/audio'])
  } finally {
    await resolver.close()
  }
})

test('unlisted-node errors identify only the host, never signed paths or query tokens', () => {
  assert.throws(
    () => approvedUrl('https://new-cdn.example/private-path?token=secret-value'),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_MEDIA_HOST')
      assert.equal(error.mediaHost, 'new-cdn.example')
      assert.ok(error.message.includes('new-cdn.example'))
      assert.doesNotMatch(error.message, /private-path|secret-value|token=/)
      return true
    },
  )
})
