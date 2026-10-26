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
    version: '0.21.0',
    summary: '评论按需查看，直播随心遮挡，也能跟上熟悉的声音。',
    homepage: 'https://greasyfork.org/zh-CN/scripts/585978',
    source: '/plugins/bili-comment-blindbox.user.js',
    tags: ['评论防护', '三人跟车', '随机车白名单', '托管遮挡', '画面调色'],
    features: [
      {
        title: '先遮住，再决定看不看',
        body: '为 B 站评论、用户名、头像和图片提供遮罩，按需查看；保留原有开关、语言和动物文字设置。',
      },
      {
        title: '我来同你玩',
        body: '在直播弹幕的用户菜单里点击「一键跟车」，最多同时跟车三人，每位后面的 × 都能单独取消。也可开启路怒模式（随机车）；单次发送失败或没有回显时跳过本条，跟车保持开启，后续符合规则的新弹幕继续处理。',
      },
      {
        title: '随机跟车，跳过不想跟发的人',
        body: '点击弹幕用户名，在「一键跟车」下方添加至白名单；名单按直播间独立保存在本地。在随机车开关下方查看白名单，可逐个移除或一键清空；白名单只过滤随机跟车，手动指定的对象仍按你的选择处理。',
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
