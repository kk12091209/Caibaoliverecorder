# Windows 精简发布

发布物包括标准 ZIP、7z 便携包，以及 `-setup.exe` 中文安装包。ZIP 可用 Windows 自带解压功能打开。安装版使用 Inno Setup 6.7.3 的现代中文向导，支持选择目录、快捷方式、Windows 卸载记录和程序目录的卸载入口；仅为当前用户安装，不需要管理员权限。三种包使用同一套运行文件，用户只需下载其中一个，不需要安装 Node、FFmpeg 或开发 SDK。

每个版本都重新构建、核对体积和文件哈希，以对应 Release 的体积报告为准。本机安装与功能测试不代表已在一台全新 Windows 系统上验收。

安装包的下载体积门槛按严格的 100,000,000 字节计算，构建超限会失败。标准 ZIP 使用 Deflate，压缩率较低，不适用该门槛；体积单独记录在报告中，不声称 ZIP 小于 100 MB。解压体积、用户后续录像和系统 WebView2 运行时另计。Windows 10/11 x64 必须已有 .NET Framework 4.7.2+ 和 WebView2 Evergreen；缺少时需从微软另行下载安装。

## 用户目录布局

```text
录播机.exe
使用说明.txt
程序组件/
  录播机.exe.config
  live-editor/server、dist、package.json
  runtime/node、recorder、desktop、ffmpeg
  LICENSE、licenses/
  release-manifest.json
导出视频默认路径/
  完整素材/
  导出片段/
```

程序组件统一保留在同一个文件夹中，普通用户只需双击顶层 EXE。两个视频目录由脚本新建为空目录，运行后分别存放完整录像和剪辑导出；不收录开发电脑已有的视频或用户数据。内部录制数据在首次运行后创建，不包含在下载包中。

源码 ZIP 独立提供给开发者，不嵌入运行包，也不要求普通用户下载。构建工作目录和源码可以与实际运行组件分开放置。

## 构建

发布脚本兼容 Windows PowerShell 5.1 与 PowerShell 7；`.ps1` 文件保留 UTF-8 BOM，确保 Windows 自带 PowerShell 正确读取中文路径。工具通过 Node 24 的 HTTPS 下载并校验固定 SHA-256，不依赖 Internet Explorer 初始化。

1. 在源码的 `live-editor` 目录先执行 `. ./scripts/dev-env.ps1`，使当前进程的缓存和临时文件留在源码仓库 `.tools` 下；然后恢复依赖、运行 `npm test`、`npm run build`，构建 `desktop/build.ps1`。
2. 运行 `scripts/prepare-release-tools.ps1 -Destination <工具缓存> -Node <Node24路径>`。下载并校验固定版本的 7-Zip 与 Inno Setup，并用 `build-ffmpeg.ps1` 在源码 `.tools` 下构建 FFmpeg 8.1.2。临时 MSYS2、编译器和依赖也留在 `.tools`，不改变全局环境变量；中文路径编译使用临时盘符别名，构建结束解除映射。FFmpeg 保留所有原生格式处理、x264、ASS 和 AMF/NVENC/QSV，只移除未使用的外部库、文档、调试信息及 FFplay。运行依赖按 PE 导入递归收集，不凭 DLL 文件名猜测。输出的 `ffmpeg-slim` 包含文件哈希、精确配置、包版本和依赖许可；发布时全部核对。
3. 准备运行时目录中的 `node/node.exe`（Node 24.12.0）及自包含 .NET 8 录制核心 `recorder`。`-RuntimeRoot` 直接指向这个运行时目录；不指定时依次查找 `ProjectRoot/程序组件/runtime`、`ProjectRoot/runtime`、`ProjectRoot` 父目录的 `程序组件/runtime`。保留恢复过的 NuGet 缓存以收集许可。脚本不会运行现有录制服务，也不会打开现有用户数据库。
4. 在 PowerShell 中运行：

```powershell
./scripts/build-release.ps1 -ProjectRoot '<源码仓库根目录>' `
  -AppRoot '<最新 live-editor 源码目录>' `
  -DesktopRoot '<desktop/package 目录>' `
  -RuntimeRoot '<包含 node 与 recorder 的 runtime 目录>' `
  -ToolsRoot '<工具缓存>' -OutputRoot '<新的输出目录>' -Version '0.1.5'
```

输出目录中的版本目录和文件必须不存在；脚本不会覆盖已有版本，也不做递归删除。工具缓存默认 `ProjectRoot/.tools/release-tools`，构建目录默认 `ProjectRoot/.tools/release-work`。`DesktopRoot` 须使用当前桌面构建输出，其中配置和桌面 DLL 已位于 `程序组件`。默认输出 ZIP、安装包、体积/哈希报告及未压缩工作目录，额外传入 `-Include7z` 才生成 7z。`程序组件/release-manifest.json` 记录版本与逐文件 SHA-256。安装版额外加入安装器许可、卸载程序与卸载快捷方式。安装器脚本与中文翻译许可位于 `installer`。

安装包及可选 7z 使用 128 MiB LZMA2 字典。共享 FFmpeg DLL 在安装目录中只存一份；压缩字典只增加解压期间的内存，不改变软件运行时内存。压缩任务属于开发发布步骤，内存需求高于解压。没有使用启动时重复解压的单文件应用方案。

完成后分别运行 `scripts/test-release.ps1 -Package <ZIP或7z> -OutputRoot <新的测试解压目录>`，核对逐文件 SHA-256、顶层四项、空视频目录、隐私排除，并验证随包 Node SQLite 与 FFmpeg 软件编码。新布局清单的 `layoutVersion` 为 2。

再运行 `scripts/test-installer.ps1 -Stage <未压缩工作目录> -ToolsRoot <工具缓存>`。脚本编译独立 QA 身份，在 `.tools/release-qa` 实际执行安装、升级与卸载；核对文件哈希、快捷方式与卸载记录、忙时拒绝维护、空闲安全退出。升级必须保留录像、数据库和导出视频；卸载必须删除整个安装目录，包括原片、分片、render-cache、临时文件、浏览器资料、数据库备份和未登记文件。安装目录外的文件及目录链接目标必须保留。安装与卸载不强制结束正在录制或处理的后台，不使用真实录像目录做测试。

v0.1.3 起采用完整卸载。安装只接受专用文件夹，拒绝磁盘根目录、系统目录和没有本程序安装信息的非空共享目录。安装后保存产品身份与绝对目录标记；卸载前再次核对身份和路径，再执行安装目录清理。卸载确认明确告知目录内全部文件会永久删除，用户需先将要保留的文件移到目录外。升级没有目录清理动作；便携版不创建卸载记录。

## 包含与排除

白名单包含桌面程序、WebView2 互操作 DLL、Node、录制核心的 DLL/EXE/runtimeconfig/deps、精简 FFmpeg 的 ffmpeg/ffprobe 和经过依赖核对的共享 DLL、当前前端入口引用的资源、服务端 JS、许可证与依赖元数据。精简构建保留 libass、libx264 以及 AMF/NVENC/QSV 接口；显卡是否可用仍由程序实际探测，失败时回退软件编码。没有删掉 CPU 回退功能来减少体积。

不包含录像、切片、导出文件、弹幕、用户配置、Cookie、数据库、日志、浏览器资料、node_modules、调试符号、旧前端 bundle、开发 SDK、FFplay。不可把运行中的项目根目录直接压缩上传。也不可把用户数据里的内部片段当作无用缓存删除。

当前发布脚本不裁剪录制核心的 .NET 程序集：反射、GraphQL 和动态序列化可能隐式使用它们；仅凭文件名删除容易使少见操作损坏。压缩和选择必要的 FFmpeg 构建能减少下载量，而不承担这些运行风险。

验证完成后，可运行 `scripts/clean-build-artifacts.ps1` 先查看过期构建清单，确认后传入 `-Apply`。它只覆盖列出的旧发布包、重复运行组件和生成的编译目录；保留当前源码、Git 发布工作区、历史资料、开发 SDK/NuGet 许可缓存和用户数据。媒体编译工作目录和验证解压目录在保存报告后按明确路径清理，不将其复制到用户安装包。

## 许可与公开发布

包内 `程序组件/LICENSE` 与 `程序组件/licenses` 保留项目 GPL-3.0、Node 及其第三方声明、对应 .NET 运行时声明、WebView2、Vue、Lucide、FFmpeg 和 7-Zip 许可，以及录制核心 NuGet 依赖的版本、作者、版权、许可文件/元数据。仍须在公开发布时提供本项目该版本的完整对应源码（包括录制核心改动与构建脚本）和 GPL 组件的对应源码获取渠道；仅放二进制或指向不对应版本的最新源码不够。本项目的发布仓库为 https://github.com/kk12091209/Caibaoliverecorder；打包脚本只生成本地文件，不会自动上传。

脚本默认生成本地候选。公开构建必须额外传入 `-ForPublic -SourceUrl '<本项目该版本的完整源码归档或标签HTTPS地址>'`。脚本会拒绝缺失地址及直接把上游仓库当成修改版源码的做法；发布者仍须核实该地址确实包含完整且对应版本的源码、构建说明与依赖源码取得方式，不能把 URL 参数检查当成完整许可审计。

来源：

- BililiveRecorder：https://github.com/BililiveRecorder/BililiveRecorder
- Node 24.12.0：https://github.com/nodejs/node/tree/v24.12.0
- FFmpeg 8.1.2：https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz （固定 SHA-256、配置、依赖版本及许可在包内 licenses/ffmpeg；构建脚本见 scripts/build-ffmpeg.ps1）
- 7-Zip 26.03：https://github.com/ip7z/7zip/releases/tag/26.03
- .NET 运行时：https://github.com/dotnet/runtime
- WebView2：https://developer.microsoft.com/microsoft-edge/webview2/

## 从 Mac 发起 Windows 云端构建

在 GitHub Actions 手动运行 `Windows release package` 工作流，选择要发布的源码分支。工作流在 Windows runner 上运行 `build-windows-ci.ps1`，重新构建前端、Windows 桌面壳和录制核心，执行共用回归、真实核心生命周期、安装/升级/卸载以及 ZIP/7z 校验，成功后生成 `windows-版本` 附件。工作流只生成构建附件，不自动创建 Release。

本流程的 Node 24.12.0 与 FFmpeg 8.1.2 沿用已发布 v0.1.3 的相同二进制，先核对整个旧 ZIP 的固定 SHA-256，再校验逐文件清单；只复制 Node 和 FFmpeg 及对应许可，不复用旧界面、桌面壳、录制核心或用户数据。媒体配置与依赖源码来源随包保留在 `程序组件/licenses/ffmpeg`。需要修改媒体构建时，使用前述 `build-ffmpeg.ps1` 重新生成组件并核对版本与哈希。

发布附件含中文安装包、ZIP、7z、安装体积报告、完整对应源码及清单、`windows-build.json` 与 `SHA256SUMS.txt`。`windows-build.json` 记录确切源码提交和检查结果；发布标签必须指向该提交。云端安装与软件编码测试不等同于用户显卡硬件加速、WebView2 窗口和真实直播的完整实机验收。
