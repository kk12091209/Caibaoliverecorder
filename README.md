<div align="center">
  <img src="live-editor/src/assets/app-icon.png" width="88" alt="菜包宇宙" />
  <h1>菜包宇宙 · Caibao Universe</h1>
  <p>直播录制、内容下载、口播与浏览器小工具的开源项目。</p>
  <p><a href="https://caibao.media">在线使用</a> · <a href="https://github.com/kk12091209/Caibaoliverecorder/releases/latest">下载录包机</a> · <a href="docs/ARCHITECTURE.md">项目架构</a> · <a href="CONTRIBUTING.md">参与开发</a> · <a href="https://github.com/kk12091209/Caibaoliverecorder/issues">反馈问题</a></p>
</div>

这个仓库包含菜包宇宙网站与菜播·录包机的源码。各产品独立运行、测试和发布；只有录包机提供 Windows / Mac 安装包，其余工具在网页中使用。

作者：**糊涂小菜包** · 技术支持：**藤椒麦旋风** · [联系我们](https://space.bilibili.com/5162836)

## 产品

| 产品 | 使用方式 | 源码与开发说明 |
| --- | --- | --- |
| **菜播·录包机** | [下载 Windows / Mac 版](https://github.com/kk12091209/Caibaoliverecorder/releases/latest) | [live-editor](live-editor/README.md)：直播录制、回看、弹幕剪辑与导出 |
| **菜包下载助手** | [在线使用](https://caibao.media/tools/downloader) | [website](website/README.md)：抖音视频/图文与 B 站视频/分 P |
| **菜包口播助手** | [在线使用](https://caibao.media/tools/teleprompter) | [口播模块](website/src/features/teleprompter)：文稿、提词、浏览器录制 |
| **浏览器插件** | [在线查看与安装](https://caibao.media/works/browser-plugins) | [页面模块](website/src/features/plugins) · [用户脚本](website/public/plugins) |
| **菜包宇宙官网** | [打开网站](https://caibao.media) | [产品与官网模块](website/src/features/catalog) |

## 下载

GitHub [Releases](https://github.com/kk12091209/Caibaoliverecorder/releases/latest) 继续只发布录包机安装包及其对应源码、许可和校验文件。仓库名称与历史 Release 地址保持兼容，已有应用内更新和官网下载地址继续使用。

- Windows 10 / 11 x64：选择 `*-setup.exe` 安装包，或完整解压便携包。
- Mac M 系列、macOS 14+：选择 `*-macos-arm64.dmg`，将应用拖入“应用程序”。当前版本未经过 Apple 公证，首次打开方式见[完整使用指南](docs/RECORDER.md)。
- `Source code` / GitHub “Download ZIP” 是开发源码，不能当作安装包运行。

## 快速开始

普通用户从上表进入在线产品，或下载录包机。录包机的录制、保存、升级、日志和卸载说明已集中到[使用指南](docs/RECORDER.md)，历史更新保留在 [CHANGELOG](CHANGELOG.md)。

开发者按需进入对应应用，不需要一次安装全部产品的依赖：

```sh
# 网站：Node.js 22.18+，默认启动本机前端
cd website
npm ci
npm run dev

# 下载助手前后端一起启动；需要 Chrome / Chromium、FFmpeg
npm run dev:downloader
```

录包机还需要录制核心和桌面运行组件，请按 [live-editor 开发指南](live-editor/README.md) 准备环境。

## 目录与维护

| 路径 | 职责 |
| --- | --- |
| `website/` | 官网和在线产品、下载 API、独立测试与部署模板 |
| `live-editor/` | 录包机工作台、后台、Windows / macOS 桌面壳及打包工具 |
| `BililiveRecorder.*`、`test/` | 上游录制核心、配套项目及核心测试 |
| `webui/`、`config_gen/` | 录制核心配套界面与配置生成工具 |
| `docs/` | 仓库总览和录包机使用指南 |

详细依赖边界、变更入口和发布关系见[架构说明](docs/ARCHITECTURE.md)。网站源码公开不自动部署生产；开发中的功能与线上版本区别见 [website/README.md](website/README.md#源码与线上版本)。

## 开源许可与致谢

原创代码沿用 [GNU GPL v3](LICENSE)。录包机基于 [BililiveRecorder](https://github.com/BililiveRecorder/BililiveRecorder)，保留上游版权和许可声明，是独立发行版。第三方组件保留各自许可，见[录包机来源](THIRD_PARTY_NOTICES.md)和[网站来源](website/THIRD_PARTY_NOTICES.md)。

仓库不包含生产密钥、账号环境文件、用户数据、真实录像、下载缓存或部署备份。提交问题时也请移除 Cookie、认证信息和私人内容。
