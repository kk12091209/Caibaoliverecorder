import { recorderImage, teleprompterImage } from './product-images'
import browserPluginsImage from '../../../assets/products/browser-plugins.svg'
import { browserPlugins } from '../../../shared/data/browser-plugins'

export type PlatformId = 'windows' | 'macos'

export type DownloadFile = {
  id: string
  platform: PlatformId
  label: string
  format: string
  size: string
  href: string
  name?: string
  sha256?: string
  primary?: boolean
  hint: string
}

export type WorkImage = {
  src: string
  srcSet?: string
  avifSrcSet?: string
  alt: string
  width: number
  height: number
}

export type Work = {
  slug: string
  name: string
  nameEn: string
  tagline: string
  summary: string
  featured?: boolean
  kind?: 'collection'
  appPath?: string
  useTitle?: string
  useSummary?: string
  showcase?: { description?: string; meta?: string; image?: WorkImage }
  screenshots?: (WorkImage & { caption: string })[]
  status: 'released' | 'preview'
  version: string
  releasedAt: string
  category: string
  github?: string
  releaseUrl?: string
  sources?: { name: string; url: string }[]
  license: string
  platforms: { id: PlatformId; label: string; requirements: string[] }[]
  downloads: DownloadFile[]
  highlights: { index: string; title: string; body: string }[]
  updates: string[]
  steps: { title: string; body: string }[]
  notes: { title: string; body: string }[]
}

export const studio = {
  name: '菜包宇宙',
  nameEn: 'Caibao Universe',
  author: '糊涂小菜包',
  support: '藤椒麦旋风',
  bilibili: 'https://space.bilibili.com/5162836',
  github: 'https://github.com/kk12091209',
}

export const works: Work[] = [
  {
    slug: 'caibo-recorder',
    name: '菜播·录包机',
    nameEn: 'Caibo Recorder',
    tagline: '把一场直播，收成可以回看和剪辑的作品。',
    summary:
      '在自己的电脑上录下 B 站或抖音直播，边录边回看、按波形和弹幕选段，再导出纯净版或弹幕版。录像和剪辑数据都留在本机。',
    featured: true,
    showcase: {
      description: 'B 站、抖音直播的本地录制、回看与剪辑。',
      meta: 'Windows / macOS',
      image: {
        ...recorderImage,
        alt: '菜播·录包机操作示例：在时间轴上选择两段素材，查看音频波形和弹幕，再导出选段；示例画面不含人物。',
      },
    },
    screenshots: [
      {
        ...recorderImage,
        alt: '菜播·录包机选段界面：两段已保存的选段、音频波形、弹幕列表和导出按钮。',
        caption: '查看波形、定位弹幕，把想留下的内容选成片段。',
      },
    ],
    status: 'released',
    version: '',
    releasedAt: '',
    category: '桌面工具',
    github: 'https://github.com/kk12091209/Caibaoliverecorder',
    license: 'GPL-3.0',
    platforms: [
      {
        id: 'windows',
        label: 'Windows',
        requirements: [
          'Windows 10 / 11，64 位',
          '.NET Framework 4.7.2 或更高',
          'Microsoft Edge WebView2',
        ],
      },
      {
        id: 'macos',
        label: 'Mac',
        requirements: ['Apple 芯片（M 系列）', 'macOS 14 或更新', '暂不支持 Intel Mac'],
      },
    ],
    downloads: [
      {
        id: 'win-setup',
        platform: 'windows',
        label: 'Windows 安装包',
        format: 'EXE',
        size: '',
        href: '',
        primary: true,
        hint: '推荐。安装后可在软件里检查更新。',
      },
      {
        id: 'win-portable',
        platform: 'windows',
        label: 'Windows 便携版',
        format: '7Z',
        size: '',
        href: '',
        hint: '解压即用。便携版需要手动覆盖来更新。',
      },
      {
        id: 'mac-dmg',
        platform: 'macos',
        label: 'Mac 安装镜像',
        format: 'DMG',
        size: '',
        href: '',
        primary: true,
        hint: '打开后把应用拖进“应用程序”。',
      },
      {
        id: 'mac-zip',
        platform: 'macos',
        label: 'Mac 压缩包',
        format: 'ZIP',
        size: '',
        href: '',
        hint: '完整解压后，把 .app 拖进“应用程序”。',
      },
    ],
    highlights: [
      {
        index: '01',
        title: '开播就录',
        body: '添加 B 站或抖音直播间，等待开播后自动录制。支持同时监控多个房间。',
      },
      {
        index: '02',
        title: '边录边看',
        body: '直播还在继续，也能回看已经录下的内容，在同一条时间轴上标记想要的片段。',
      },
      {
        index: '03',
        title: '顺着声音和弹幕找',
        body: '通过音频波形、弹幕密度和弹幕搜索定位内容，也能按录制时间查找。',
      },
      {
        index: '04',
        title: '导出时再决定样子',
        body: '每个选段独立导出，可选纯净版、弹幕版，或两份都要。弹幕样式也可以调整。',
      },
    ],
    updates: [],
    steps: [
      {
        title: '按系统下载',
        body: 'Windows 运行安装包，或把便携版完整解压。Mac 从镜像里把“菜播·录包机”拖进“应用程序”。',
      },
      {
        title: '添加直播间',
        body: '打开软件，粘贴直播链接或纯数字房间号。只有一个匹配时会直接添加；两边同号时，先确认主播再添加。',
      },
      {
        title: '回看并选段',
        body: '在左侧点开素材。拖动标记确定起止，看一看旁边的时长，再点“添加选段”。',
      },
      {
        title: '导出成片',
        body: '勾选片段后选择纯净版、弹幕版或双文件。任务按顺序处理。完成后在任务里打开文件夹即可。',
      },
    ],
    notes: [
      {
        title: '文件留在本机',
        body: 'Mac 默认把成片放到“影片/菜播·录包机”，内部数据在个人资源库。Windows 默认写在程序旁边的“导出视频默认路径”。设置里可以改导出位置。',
      },
      {
        title: 'Mac 第一次打开',
        body: '当前 Mac 版有临时签名，还没有经过 Apple 公证。若系统提示无法验证开发者，到“系统设置 → 隐私与安全性”里选择“仍要打开”。不需要关闭整台电脑的安全检查。',
      },
      {
        title: '安装包与源码',
        body: '日常使用选择下面的 Windows 或 Mac 安装包即可。源码链接供开发者查看，软件内也可以检查更新。',
      },
      {
        title: '许可与来源',
        body: '录制核心来自 BililiveRecorder，整体遵循 GPL-3.0。菜播·录包机是独立的录制与剪辑工作台，不是上游的官方发行版。',
      },
    ],
  },
  {
    slug: 'teleprompter',
    name: '菜包口播助手',
    nameEn: 'Caibao Teleprompter',
    tagline: '把想说的话，留给你的节奏。',
    summary:
      '粘贴台本，为每段安排时间，再从原文中选择要说的内容。在电脑或手机浏览器里，跟着逐字阅读进度完成口播，也可录制视频或声音并保存到本机。',
    appPath: '/tools/teleprompter',
    status: 'released',
    version: '在线使用',
    releasedAt: '2026.10.16',
    category: '在线工具',
    license: '',
    platforms: [],
    downloads: [],
    updates: [],
    showcase: {
      description: '为台本分段、安排时间，在浏览器里从容提词。',
      meta: '网页 / 手机浏览器',
      image: {
        ...teleprompterImage,
        alt: '菜包口播助手操作案例：台本分段、逐字阅读进度与本地录制，摄像头关闭，不含人物。',
      },
    },
    screenshots: [
      {
        ...teleprompterImage,
        alt: '菜包口播助手桌面工作台，左侧安排分段，中间连贯显示台词和逐字高亮，下方实时调速及本地录制。',
        caption: '连贯阅读，逐字跟上；需要时，也把声音和画面留下。',
      },
    ],
    highlights: [
      {
        index: '01',
        title: '时间与台词，一起安排',
        body: '在同一个编辑器里安排时间、填写台词，也可从原文中滑动选字。已分配的内容会留在原位并锁定，下一段接着安排。',
      },
      {
        index: '02',
        title: '字数有参考，节奏由你定',
        body: '按本段时长与自定语速计算建议字数，实时显示已选字数和预计朗读时间，不强制限制篇幅。',
      },
      {
        index: '03',
        title: '让停顿成为台本的一部分',
        body: '分段之间的时间空档自动显示停顿倒计时，也可添加动作提示，用不同标记提醒展示产品、调整姿势或看向镜头。暂停与继续会保留当前位置。',
      },
      {
        index: '04',
        title: '看见自己，也看见台词',
        body: '按需开启摄像头取景并录制视频，或只使用麦克风录音。保存时支持音画分离，可选视频、音频或两者。',
      },
    ],
    steps: [
      {
        title: '放入台本',
        body: '粘贴全文、复制时间模板填写，或直接添加第一段台词。从空白台本开始，只展示你自己的内容。',
      },
      {
        title: '安排分段',
        body: '添加一段，在同一处填写时间和台词，也可从原文滑动选取。按字数参考调整，确认后添加。',
      },
      {
        title: '开始口播',
        body: '按播放开始，整篇台词连贯滚动，阅读进度逐字划过。可随时加速、减速或暂停，也可同步录制。',
      },
    ],
    notes: [
      {
        title: '退出后会保留台本吗？',
        body: '台本、分段和未保存的录制只在本次页面中保留。刷新或退出后不会恢复，请在本次使用结束前保存视频或音频。',
      },
      {
        title: '录制与保存',
        body: '开启取景只预览，不会自动录制。点击开始录制后会申请麦克风权限，也可仅录音；手机取景时可翻转前后摄像头。结束后填写保存名称并确认，再保存到本机，勾选音画分离可保存无声视频、独立音频或两者的 ZIP。格式根据浏览器支持情况显示，单次上限 256 MB。',
      },
      {
        title: '切换页面时会怎样？',
        body: '离开前台或锁屏时会暂停口播。屏幕常亮需要浏览器支持，具体是否生效会在预览下方显示。',
      },
    ],
  },
  {
    slug: 'media-downloader',
    name: '菜包下载助手',
    nameEn: 'Caibao Downloader',
    tagline: '把视频和图片，按需留在手边。',
    summary:
      '粘贴抖音或 B 站的作品链接，预览视频和图片。图文可以逐张查看、多选打包，B 站分 P 可以列出后勾选下载。',
    appPath: '/tools/downloader',
    useTitle: '选好内容，再保存。',
    useSummary: '粘贴分享链接，预览内容后选择要下载的图片或分 P。',
    status: 'released',
    version: '在线使用',
    releasedAt: '2026.10.21',
    category: '在线工具',
    license: '',
    platforms: [],
    downloads: [],
    updates: [],
    showcase: { description: '保存抖音与 B 站的视频、图文和分 P。', meta: '网页 / 在线使用' },
    highlights: [
      {
        index: '01',
        title: '分享链接，直接识别',
        body: '支持抖音和 B 站的短链接、完整链接，也可以粘贴整段分享文字。',
      },
      {
        index: '02',
        title: '图片，按张挑选',
        body: '图文展示全部可获取的缩略图，点击查看大图。可以保存单张，也可以勾选后打包下载。',
      },
      {
        index: '03',
        title: '分 P，选好再保存',
        body: '从同一投稿任意分 P 的链接，列出完整分 P 列表，按需选择下载。',
      },
    ],
    steps: [
      { title: '粘贴链接', body: '把作品分享链接或分享文字放入输入框，点击解析链接。' },
      {
        title: '预览和选择',
        body: '查看作品信息，预览图片或视频，勾选想要保存的图片或分 P。',
      },
      {
        title: '保存文件',
        body: '视频保存为 MP4，图片保存为 JPG / PNG。多选内容可以打包为 ZIP。',
      },
    ],
    notes: [
      {
        title: '画质和水印',
        body: '抖音使用平台可提供的无水印视频和图片源。图片保留原始分辨率，普通图片转为高质量 JPG，带透明背景的图片转为 PNG；视频以 MP4 封装，不放大转码。B 站免登录优先获取 1080P，并比较实际可下载的全部档位，自动选择最高可用画质。',
      },
      {
        title: '临时文件',
        body: '媒体在服务器临时准备，完成后请及时保存。临时文件约一小时后清理，刷新页面后需重新解析。',
      },
      {
        title: '单次下载额度',
        body: '单个文件及每次下载合计最多 4 GB，每位访客最多同时处理两个任务。服务器空间不足时会提示稍后重试；内容较大时可以分批保存。',
      },
    ],
  },
  {
    slug: 'browser-plugins',
    name: '浏览器插件合集',
    nameEn: 'Browser Tools',
    kind: 'collection',
    tagline: '给浏览器，加一点顺手的功能。',
    summary: '一些在浏览器里使用的小工具。逐个了解功能，前往插件主页，或查看并复制完整源码。',
    status: 'released',
    version: `${browserPlugins.length} 个插件`,
    releasedAt: '',
    category: '浏览器工具',
    license: '',
    showcase: {
      description: '从评论防护开始，收集顺手的浏览器小工具。',
      meta: '用户脚本 / 源码可复制',
      image: {
        src: browserPluginsImage,
        width: 1280,
        height: 880,
        alt: '浏览器插件合集功能示意：评论防护、三位跟车对象和源码入口，无人物照片。',
      },
    },
    platforms: [],
    downloads: [],
    highlights: [],
    updates: [],
    steps: [],
    notes: [],
  },
]
