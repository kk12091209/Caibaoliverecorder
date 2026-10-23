export type BrowserPlugin = {
  slug: string
  name: string
  version: string
  summary: string
  homepage: string
  source: string
  tags: string[]
  features: { title: string; body: string }[]
}

export const browserPlugins: BrowserPlugin[] = [
  {
    slug: 'bili-comment-blindbox',
    name: 'B站评论盲盒防护',
    version: '0.20.0',
    summary: '评论按需查看，直播随心遮挡，也能跟上熟悉的声音。',
    homepage: 'https://greasyfork.org/zh-CN/scripts/585978',
    source: '/plugins/bili-comment-blindbox.user.js',
    tags: ['评论防护', '三人跟车', '托管遮挡', '画面调色'],
    features: [
      {
        title: '先遮住，再决定看不看',
        body: '为 B 站评论、用户名、头像和图片提供遮罩，按需查看；保留原有开关、语言和动物文字设置。',
      },
      {
        title: '我来同你玩',
        body: '在直播弹幕的用户菜单里点击「一键跟车」，最多同时跟车三人，每位后面的 × 都能单独取消。「开启路怒模式（随机车）」与「当前直播间禁用跟车」也保留在设置里。',
      },
      {
        title: '你写你的，跟车照常',
        body: '自动发送与网页输入框分开处理。正在打字、有草稿或使用中文输入法时，不会覆盖内容或移动光标；多位用户的新弹幕按原有冷却间隔依次处理。',
      },
      {
        title: '托管一块画面',
        body: '选黑、白、蓝等纯色，或使用本地图片。在直播画面内拖动，用八个控制点自由缩放，移入后可锁定或解锁。遮挡仅本次使用，不保存到房间配置；刷新或重新打开后默认关闭。图片不上传，也不改变原始视频。',
      },
      {
        title: '为直播间留一套画面风格',
        body: '分别调整亮度、对比度、饱和度、鲜艳度、色温和 RGB 曲线，使用当前帧或实时画面对照预览。预设按直播间保存在本地，主画面与独立摄像头一起生效；托管图片和播放器按钮保持原样。',
      },
    ],
  },
]
