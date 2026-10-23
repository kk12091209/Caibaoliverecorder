# 菜包宇宙网站

官网、菜包下载助手、菜包口播助手与浏览器插件的完整源码。页面地址、视觉样式和操作方式保持现有设计。

在线使用：[caibao.media](https://caibao.media)。普通用户无需构建网站；录包机安装包仍在仓库的 [Releases](https://github.com/kk12091209/Caibaoliverecorder/releases/latest)。

## 本地开发

需要 Node.js 22.18+（CI 使用 24.12.0）和 npm。

```sh
cd website
npm ci
npm run dev
```

默认打开 `http://127.0.0.1:5173`。官网、口播助手和插件页面可用。口播助手使用浏览器摄像头/麦克风，录制内容留在本机；相机权限需要 HTTPS 或 localhost。

下载助手需要同时启动本地 API：

```sh
npm run dev:downloader
```

打开 `http://127.0.0.1:17970/tools/downloader`。默认只监听本机。需要系统安装 FFmpeg / FFprobe 和 Chrome / Chromium；可通过 `FFMPEG_PATH`、`FFPROBE_PATH`、`DOWNLOADER_CHROME` 指定可执行文件。录包机开发环境已经准备好的 `.tools/runtime/ffmpeg/` 也可复用，不依赖仓库目录名称。macOS 可以使用本目录的启动/停止 `.command` 文件。

纯页面开发不需要云账号、存储桶密钥或生产服务器权限。测试使用合成媒体和模拟上游响应，不读取真实录像或登录 Cookie。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite 前端开发 |
| `npm run dev:downloader` | 前端与下载 API 一起启动 |
| `npm test` | 全部单元、HTTP 流、媒体及模块边界测试 |
| `npm run build` | TypeScript 检查与生产构建 |
| `npm run check` | 格式、测试与构建 |
| `npm run format` | 统一 TypeScript / 服务端源码格式 |
| `npm run package:deploy` | 生成独立部署归档，不连接线上服务器 |
| `npm run sync:check` | 只读核对 GitHub 录包机发布，需联网 |

部署见 [DEPLOYMENT.md](DEPLOYMENT.md)，目录边界见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，下载行为见 [DOWNLOADER.md](DOWNLOADER.md)。

## 源码与线上版本

这是网站的开发源码，提交到 GitHub 不会自动替换生产服务。仓库包含本地验证阶段的抖音实况识别、预览与 MP4 保存；这部分尚未包含在现有 `20261022-1510-native-download` 线上发布中。后续发布需独立测试和部署，不能把“源码已公开”当作“全部功能已上线”。

`public/releases/catalog.json` 是公开安装包信息的本地回退快照。生产清单由同步服务独立更新，网站构建不覆盖它。`public/plugins/` 是用户直接安装的脚本，URL、元信息和第三方声明需保持兼容。

## 许可与公开范围

本目录原创代码沿用仓库的 [GNU GPL v3](LICENSE)。第三方代码和依赖保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。产品图片、标识和名称用于展示本项目，不代表对其中第三方内容另行授予权利。

源码不包含环境文件、生产凭据、下载缓存、真实录像、用户数据、部署备份或退役业务数据。`deploy/` 提供配置模板；部署者需要填自己的域名和账号。
