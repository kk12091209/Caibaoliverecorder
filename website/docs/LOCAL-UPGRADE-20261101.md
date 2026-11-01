# 本地升级候选与部署契约

本轮仅修改和验证源码，没有上传、同步发布或部署。网站开发源是根仓库的 `website`；录播机开发源是 `.tools/douyin-local-source-20261101`。不要从旧根目录 `live-editor` 覆盖 0.3.5 副本。

## 部署清单

`deploy/compose.downloader.yaml` 与 Caddy 的三个现有路由一一对应。三个实例使用相同不可变镜像版本，各自使用独立 Cookie 名称、任务内存及缓存目录：

| 路由 | 服务 / 网络别名 | 缓存 |
| --- | --- | --- |
| `/api/downloader` | downloader / caibao-downloader | `/srv/caibao/download-cache` |
| `/api/downloader-xhs` | downloader-xhs / caibao-downloader-xhs | `/srv/caibao/download-cache-xhs` |
| `/api/downloader-xhs-v2` | downloader-xhs-v2 / caibao-downloader-xhs-v2 | `/srv/caibao/download-cache-xhs-v2` |

继承配置不合并主服务网络别名，防止解析被错误分发到其他前缀的实例。XHS 健康检查使用各自 API 前缀；三实例资源预算分别计算。回滚时保留各自旧镜像标签和配置，先停收新任务、等待下载租约结束，再替换对应实例。不得清空用户活动缓存、复用同一个缓存卷，或只回滚静态页而保留不兼容服务。

本机已解析 YAML 并核对三个服务的环境、别名和卷；尚未执行目标 Linux 主机的 Docker Compose、Caddy 校验或启动新容器。发布前必须在目标环境完成 `docker compose config`、逐服务健康检查、三种 API 的真实下载及旧版本回滚。此文档不授权部署。

## 版本与构建

`npm run check` 现在同时核对两个用户脚本的版本与合集条目一致、下载服务依赖版本与网站依赖一致，并检查共享自动发送代码未漂移。本轮保留现有产品版本号，标记为未发布工作区；选定发布候选后统一更新版本，不把本地未验收改动冒充已经发布。

录播机签名附件继续沿用 GitHub 的 `caibao-update.json`，镜像公开入口仍为 `caibo-recorder-update.json`。旧客户端兼容附件 `update-manifest.json` 继续生成，新候选的备用更新和 macOS 修复不接受它代替签名附件。

## 重复验证入口

- `npm run check`：格式、共享发送代码、版本契约、测试与构建。
- `node scripts/verify-auto-sender.mjs`：多文档 Web Locks 与账号级发送节奏。
- `node scripts/verify-plugin-dom.mjs`：真实 DOM/MutationObserver。
- `node scripts/verify-send-intercept.mjs`：fetch/Request/XHR 安装和受阻状态。
- `node scripts/verify-translator-lifecycle.mjs`：真实后退缓存生命周期。
- `node scripts/verify-download-lifecycle.mjs`：实际浏览器慢下载及 iframe 回收。
- `node scripts/verify-browser-egress.mjs`：本机 HTTPS 夹具、CONNECT 认证、固定地址出口、私网与越界拒绝。
- `node scripts/verify-catalog-navigation.mjs`：构建后页面锚点与错误片段。

原生浏览器夹具不发送真实 B 站弹幕。真实 Tampermonkey、平台网页兼容、iOS 峰值内存与系统相册行为仍应单独验收。
