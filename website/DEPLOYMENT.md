# 网站构建、部署与回退

网站构建和 GitHub 源码公开是两个流程。网站 CI 只检查和打包，不持有生产凭据，不自动部署。

## 本地验证

```sh
cd website
npm ci
npm run check
npm run package:deploy
```

生成 `artifacts/caibao-web-<时间>.tar.gz`。归档保持独立根目录，包含前端 `dist`、下载后台、运行脚本、部署模板、依赖锁与许可。无需复制整个 Git 仓库；真实环境文件、密钥、用户数据和测试产物不得进入归档。

## 运行组件

| 组件 | 配置入口 | 持久内容 |
| --- | --- | --- |
| Caddy 静态站点 | `deploy/compose.yaml`、`Caddyfile` | TLS 数据、版本目录、独立公开 catalog |
| 下载 API | `deploy/compose.downloader.yaml` | 有限生命周期的下载缓存，不上传 COS |
| 安装包同步 | `deploy/products.json`、`sync.env.example` | 同步状态、公开 catalog；私钥另行挂载 |

模板默认使用 caibao.media 的公开域名和 `/srv/caibao`、`/opt/caibao-downloader` 目录约定。自建部署需要替换 Caddy 域名、下载服务的 `DOWNLOADER_PUBLIC_ORIGIN` 与相关公开地址；不要直接把示例当作自己的生产配置。

下载服务需要 FFmpeg、Sharp 与 Chromium。`Dockerfile.downloader` 固定浏览器镜像，并保留 Chromium 沙箱；Compose 使用只读根目录、非 root 用户、内存/进程限制和单独工作卷。`DOWNLOADER_TRUST_PROXY=true` 仅适用于 API 不直接暴露且前置代理可信的拓扑。

`COS_PUBLIC_ORIGIN`、COS 密钥、GitHub App 私钥或可选读取 Token 由部署者在仓库外配置。CAM 策略文件中的 `YOUR_APP_ID`、`YOUR_BUCKET_NAME` 必须替换成自己的资源，权限限定在产品对象前缀。只读公开仓库可以匿名读取；运行网站不要求配置发布同步。

## 版本切换

1. 完成测试、构建、归档和 SHA-256 校验；使用不可变 build id。
2. 在新版本目录解包，记录旧版本指向和镜像。先核对 `catalog.json`、录包机更新清单与线上 Caddy 配置的 SHA-256。
3. 在解包后的 `deploy/` 运行 Docker Compose，使 `context: ..` 与安全配置的相对路径正确。只更新本次涉及的组件。
4. 下载后台健康检查通过后，原子切换静态站点 `current`。保持旧版本及依赖资源可回退，勿覆盖独立安装包 catalog。
5. 验证公网页面、API、实际 MP4/图片下载、Range 续传、跨会话拒绝访问和 iOS 保存入口；复核受保护文件及安装包同步定时器。

示例后台启动命令（需先构建镜像并配置部署环境）：

```sh
cd /path/to/immutable-release/deploy
DOWNLOADER_BUILD=<build-id> docker compose -f compose.downloader.yaml up -d --no-build --wait
```

失败时恢复旧静态目录指向，并用旧版本 Compose / 镜像恢复后台。不要用新构建覆盖旧版本目录。后台重启会使进程内匿名会话失效，用户需刷新并重新解析；上线时应考虑已有下载任务。

## 浏览器缓存与私有数据

保留下载 Worker 的 URL 和旧版兼容行为；修改 Worker 协议时同时验证已有缓存的用户。保留 Caddy 下载授权、流式刷新、Range 和独立 catalog 路由，不能用简单的全站静态替换覆盖它们。

已移除的快递助手仍返回 410。私有数据目录的访问拦截与打包排除继续保留，但不重新引入该业务、测试密钥或历史数据。

## 教程构建

正常 `npm run build` 使用真实相机。`npm run build:tutorial` / `package:deploy:tutorial` 是显式教程模式，使用演示图片；不能用教程包替换正式相机功能而不说明。
