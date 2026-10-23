# 网站模块与边界

网站是一个独立的 React / Vite 应用，下载 API 是独立 Node.js 服务。它们与录包机共享仓库，不共享业务状态、依赖安装、版本号或发布生命周期。

```text
website/
├── src/
│   ├── main.tsx                 浏览器入口与全局样式加载
│   ├── app/                     工具入口分流、官网路由和按需加载
│   ├── features/
│   │   ├── catalog/             首页、关于、产品页、产品目录和安装包入口
│   │   ├── downloader/          解析、选择、预览、浏览器下载与 iOS 保存
│   │   ├── teleprompter/        文稿、播放、相机、录制和导出
│   │   └── plugins/             浏览器插件列表、详情与源码弹窗
│   ├── shared/                  通用 UI 与跨产品只读元数据
│   └── assets/                  原有图片资源
├── server/downloader/
│   ├── api.mjs                  HTTP 接口组合入口
│   ├── http/                    匿名会话、请求归属、限流
│   ├── platforms/               B 站/抖音解析、源数据规范化
│   ├── infrastructure/          网络地址校验、请求、浏览器、缓存
│   ├── jobs/                    有界队列、任务状态、文件生命周期
│   └── media/                   图片转换、音视频合并与工具定位
├── public/                      保持原 URL 的 Worker、安装脚本和公开清单
├── scripts/                     开发/服务启动、打包与录包机发布同步
├── deploy/                      容器、Caddy、定时同步与环境模板
└── tests/                       按产品分组，另有 releases/ 与 architecture/
```

## 前端约束

- `app` 负责组合产品，产品模块互不导入内部实现。只有确实被多个产品使用的 UI 或只读元数据才进入 `shared`；插件简介由 `shared/data/browser-plugins.ts` 同时提供给产品卡片和插件详情。
- `catalog` 管理官网和产品元数据。新增产品首先修改 `features/catalog/data/works.ts`；首页展示由 `showcase.ts` 派生。安装包入口读取公开 catalog，不能从浏览器连接云存储写入接口。
- `downloader/MediaDownloader.tsx` 负责页面渲染，`useMediaDownloader.ts` 负责解析、选择、取消、缓存与下载状态；`AlbumSaveDialog` 处理 iOS 系统分享，`lib` 保留 API 类型和传输逻辑。
- `teleprompter/components` 负责控件，`hooks` 负责播放与采集生命周期，`model` 负责文稿、分段、颜色、录制格式等可独立测试的逻辑。
- `App` 仅分流入口；`CatalogApp` 按需加载官网页面和安装包清单。直接打开下载助手或口播助手不应请求官网代码、产品图或安装包清单。保持插件和 3D 首页背景的延迟加载，避免聚合导出重新引入提前加载。
- 前端禁止导入 `server`、`scripts` 和 Node 内置模块。边界测试随 `npm test` 执行。

清理仅移除已经没有调用方的组件和对应样式。现用 CSS 类名、资源、路由、public URL、HTML 结构、视觉参数及业务策略保持兼容。

## 下载链路

```text
浏览器界面 → /api/downloader → 会话/归属校验 → 平台解析
                                        → 下载任务 → 媒体处理/临时文件
浏览器下载 ← /stream 或 /files ← 经校验的下载响应
```

普通下载尽早返回附件响应，继续使用原生浏览器下载列表；预览和 iOS 相册保存按原流程等到媒体准备好。服务端保留匿名会话隔离、SSRF 防护、任务/容量限制、取消和清理规则。临时文件不上传到安装包存储桶。

`public/downloader-transfer-worker.js` 和 `public/downloader-range-transfer.mjs` 是受浏览器缓存约束的稳定入口，不能随目录归类改 URL 或无计划改变消息协议。

## 发布同步

`scripts/sync-releases.mjs` 从 `deploy/products.json` 获取录包机仓库和附件规则，验证文件及签名后发布安装包目录。相关实现独立于网页和下载 API。只有录包机注册二进制分发，在线工具不产生桌面安装包。

保持 `scripts/` 入口与 `deploy/` 相对路径兼容，使打包后可以脱离整个 monorepo 运行。部署归档不含其他产品依赖或录包机源码。生产清单、密钥、缓存和持久数据位于版本目录外。

## 原目录迁移

旧网站 `src/pages`、`src/components`、`src/lib` 中的代码已按产品归入 `src/features`；测试同样按产品归类。录包机没有移动。原独立网站目录保留启动入口和源码快捷方式，完整迁移前副本在本地 artifacts/local-consolidation 中归档，后续开发以仓库内 `website/` 为唯一源码入口，避免继续维护两份版本。
