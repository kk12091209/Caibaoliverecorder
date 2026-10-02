# macOS Apple Silicon 测试版

0.1.4 增加 AppKit/WKWebView 桌面壳；Vue/Node/SQLite 和录制核心共用。
Windows 保留现有 WinForms/WebView2 壳。每个勾选片段创建独立任务，按
列表顺序串行处理；双文件模式每个任务产生两个 MP4。历史合并任务仍
按旧记录执行，完整素材导出保持一个任务。

## 下载与安装

从 [v0.1.6 Release](https://github.com/kk12091209/Caibaoliverecorder/releases/tag/v0.1.6) 下载 DMG，打开后将应用拖入 Applications，弹出磁盘映像，再从“应用程序”打开。也可下载 ZIP，解压后将 `.app` 移入“应用程序”。普通用户无需安装下面的开发工具。

要求 M 系列芯片、macOS 14 或更新。测试版使用临时签名，未公证；被系统拦截时，确认来自本仓库，按 [Apple 官方指引](https://support.apple.com/zh-cn/102445) 到“系统设置 → 隐私与安全性”选择“仍要打开”。不建议关闭系统安全检查。

本机 macOS 27.0.1 验证了合成视频逐段导出、3 个实际直播间短时录制、双文件导出、原生窗口和核心退出恢复。macOS 14、其他 Mac、长时间录制与 Windows 原生安装仍需独立实机验收；测试结果不能代替这些检查。

## 本地开发

要求 Apple Silicon、macOS 14+、Xcode Command Line Tools、Python 3.9+。

```bash
git clone --recurse-submodules https://github.com/kk12091209/Caibaoliverecorder.git
cd Caibaoliverecorder
./live-editor/scripts/prepare-macos.sh
source ./live-editor/scripts/dev-env.sh
cd live-editor
npm test
npm run test:dev
npm run dev
```

准备脚本只向仓库 `.tools` 下载工具，不安装全局 Node/.NET/FFmpeg。
Node 与媒体工具固定版本和 SHA-256；.NET SDK 固定 8.0.425，GitVersion
通过 `DOTNET_ROLL_FORWARD=Major` 使用已安装 SDK 运行时。不要用不带
Git 历史的 ZIP 代替构建仓库。

macOS 的系统临时目录可能经过 `/var` 符号链接。测试前 source 环境脚本，
使用项目内真实路径作为 TMPDIR。素材防重定向检查保持有效。

## 构建和运行

```bash
./live-editor/scripts/build-macos.sh
# 或构建并启动使用隔离数据的开发窗口：
./script/build_and_run.sh --verify
```

构建输出在 `release/macOS/0.1.6`，目录已存在时拒绝覆盖。可传入一个新的
绝对输出目录。包内包括原生窗口、前端、服务、Node、FFmpeg/FFprobe、自包含
录制核心及第三方说明。记录 SHA-256 与逐文件清单，不包含测试视频、数据库、
Cookie、真实录像、SDK 或 node_modules。默认生成临时签名 ZIP；再运行 `./live-editor/scripts/package-macos-dmg.sh /绝对路径/输出目录` 生成拖放安装 DMG。DMG 打包用的 ds_store / mac_alias 只安装到仓库 `.tools`，不随应用分发。

Mac 默认内部数据：`~/Library/Application Support/Caibo/data`；
默认导出：`~/Movies/菜播·录包机`。更新应用不删除数据。开发/QA 可设置
`CAIBO_DATA_ROOT`、`CAIBO_EXPORT_ROOT`，不与正式数据共用。

窗口与后台通过已有实例令牌协议连接。窗口锁基于数据目录，重复启动不会
打开第二个同数据窗口；服务沿用 SQLite 排他租约。应用只能导航到当前后台
的 loopback origin；文件选择桥只接受主页面消息，外部打开限于作者链接。

Mac 核心识别需核对真实进程路径与完整启动参数；停止只给验证过的进程发
SIGTERM，并等待退出。硬件导出实测 VideoToolbox 双输出，失败回退 libx264。
关闭窗口可后台运行，菜单栏/Dock 可恢复；Cmd+Q 走任务确认和恢复流程。
确认退出后，窗口等待后台进程结束才终止。录制核心停止失败时保留管理端点，
显示错误并允许再次退出，不再把“已受理”当作“已退出”。
WebKit 通过 MediaSource 加载实时 fragmented MP4，避免原生播放器的字节范围
探测被无限长度流拒绝；Windows WebView2 保留原来的直接流播放。
CLI 日志通过 BILILIVERECORDER_LOG_FILE_PATH 写入内部数据的 logs 目录，
应用包保持只读；打包排除本地运行生成的 logs，启动退出后应再次校验签名。
录制或视频处理时阻止空闲系统休眠，不能保证合盖、手动休眠后的直播连续性。

## 发布前检查

- 在 M 系列 Mac 验证 B站/抖音实际直播、中文弹幕、预览、三种导出、退出恢复、升级与长时间录制。
- Windows 运行共用回归及原生壳/安装器检查；在 Mac 通过 Node 测试不能代替 Windows 桌面验收。
- Intel 当前仅保留核心编译能力，没有已验证的 Intel 安装包。
- 正式签名发行可使用 `MACOS_SIGN_IDENTITY='Developer ID Application: ...'` 构建；脚本对嵌套 Mach-O 签名，再签外层应用。Node/.NET 使用 allow-jit entitlement。
- 公证与上传均是独立步骤；本脚本不会连接 Apple 公证服务或创建 GitHub Release。正式公证完成后应 staple 应用，重新封装 ZIP 并更新 SHA-256/manifest 公证状态。
- 在干净 Mac 上核对 Gatekeeper 与安装体验；核对对应版本源码、FFmpeg 供应商完整依赖源码/许可资料。未公证测试版必须在下载页明确标注签名与验证范围。

## 导出接口

`POST /api/sessions/:id/export` 的 `scope=clips` 将所有选中的 ranges 在一次
事务中发布到队列。单片段保留原单 job 返回，多片段返回 `{jobs:[...]}`；
前端按返回数量提示。每个 job 有 batchId/clipIndex/clipCount，取消、失败、
恢复和文件命名独立。发生准备/数据库错误时不留下半批任务。新任务不会
拼接多个选段；旧任务持久化的多范围数据仍可恢复。
