Mac 与 Windows 统一更新为 **0.1.6**。两端均支持“选中几个片段，创建几个独立任务，依次导出”。Mac 继续作为 Apple Silicon 测试版提供。

## 下载与安装

- **Mac：Caibo-0.1.6-macos-arm64.dmg**。适用于 M 系列芯片、macOS 14 或更新；打开 DMG，将应用拖入 Applications，弹出磁盘映像，再从“应用程序”打开。ZIP 为备用格式，暂不支持 Intel Mac。
- **Windows：BiliLiveEditor-0.1.6-win-x64-setup.exe**。中文安装向导；ZIP / 7z 为便携版。支持 Windows 10 / 11 x64，需要 .NET Framework 4.7.2+ 与 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
- 两端均包含 Node、FFmpeg 和录制核心，普通用户无需下载源码或安装开发工具。
- **升级无需卸载。** 退出后，Mac 替换旧 `.app`；Windows 安装到原目录。升级保留录像和设置。Windows 卸载会删除整个安装目录，外部导出目录保留；Mac 删除 `.app` 会保留用户数据。

## 修复内容

- Mac 预览改用 WebKit 支持的媒体缓冲方式，解决连续 MP4 预览流出现黑屏、“预览尚未就绪”的问题。
- Mac 确认退出后等待后台与录制核心结束，期间显示正在退出；停止失败时显示错误并允许重试，避免只关闭窗口而留下录制进程。
- Mac 录制日志写入用户数据目录，构建时排除历史日志，避免运行时破坏应用包签名。
- Windows 与 Mac 共用退出失败处理修复，并保留逐段独立任务、顺序导出与抖音 `live_web_rid` 链接支持。

## 首次打开提示

Mac 包采用临时签名，**未使用 Developer ID 签名及 Apple 公证**，因此首次打开仍可能被系统拦截。从本仓库下载后，先尝试打开一次，再到“系统设置 → 隐私与安全性”选择“仍要打开”，按系统提示确认。见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。无需关闭系统安全检查。

Windows 安装程序也未使用付费代码签名证书，可能提示未知发布者或信誉不足，请核对下载来源与 SHA-256。

## 验证与范围

- Mac 本机共用回归 511 项：508 通过、3 项跳过、0 失败；真实 B 站录制中预览、已完成录像回看、定位播放、取消退出、确认退出及后台进程结束已验证。
- Mac 包运行并退出后，严格签名完整性检查通过；DMG 内文件清单与 SHA-256 已核对。尚未完成其他 Mac、macOS 14 实机及长时间录制验收。
- Windows 发布流程重新执行共用编辑器回归、三段顺序导出、录制核心测试与生命周期、ZIP / 7z 完整性、安装、保留数据升级、忙时拒绝维护及完整卸载验证。具体结果见 `windows-build.json`。实际显卡、WebView2 窗口与真实直播仍需 Windows 实机验收。

## 校验与源码

`SHA256SUMS.txt` 对应 Windows 附件及项目源码，`Mac-SHA256SUMS.txt` 对应 Mac 附件。`macos-manifest.json` 记录 Mac 应用包逐文件清单，`macos-build.json` 记录构建和验证信息。

`Caibo-0.1.6-source.zip` 是本版本对应源码，普通用户无需下载。Mac 所用 FFmpeg 与 v0.1.4 相同，原样附上对应的 FFmpeg 及依赖源码归档 `Caibo-0.1.4-FFmpeg-upstream-sources.tar.gz`；文件名中的 0.1.4 表示该依赖归档最初发布的版本。组件许可、来源及构建配置随应用保留。Windows 继续复用经固定哈希校验的 Node 24.12.0 与 FFmpeg 8.1.2，桌面壳、编辑器和录制核心重新构建。

录制核心沿用既有依赖；NuGet 仍报告 AutoMapper 13.0.1 和 AngleSharp 0.17.1 的上游依赖告警，本次没有进行跨大版本升级。
