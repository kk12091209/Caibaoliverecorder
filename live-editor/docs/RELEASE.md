# Windows 精简发布

发布物包括 Windows 兼容的标准 ZIP、7z 和自解压 EXE，内容相同。ZIP 可用 Windows 自带解压功能打开。用户双击选择目录后，再启动里面的 `录播机.exe`；不需要安装 Node、FFmpeg 或开发 SDK。自解压层使用标准 7-Zip SFX，不请求管理员权限、不写注册表、不自动启动程序。另有相同内容的 `.7z` 包供熟悉压缩软件的用户使用。用户只需下载其中一个。

上一版 `0.1.0-preview.20260929.5` 本地实测：自解压 EXE **84,672,052 字节（84.67 MB）**，自解压用时 5.479 秒、峰值工作集约 150 MiB，逐文件哈希、Node SQLite 和软件编码验证通过。每个新版仍须重新构建和验证，以对应版本的体积报告为准。这些是本机数据，不代表所有电脑的耗时，也不代表已在一台全新 Windows 系统上验收。

7z / 自解压包的下载体积门槛按严格的 100,000,000 字节计算，构建超限会失败。标准 ZIP 使用 Deflate，压缩率较低，不适用该门槛；体积单独记录在报告中，不声称 ZIP 小于 100 MB。解压体积、用户后续录像和系统 WebView2 运行时另计。Windows 10/11 x64 必须已有 .NET Framework 4.7.2+ 和 WebView2 Evergreen；缺少时需从微软另行下载安装。

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

发布脚本兼容 Windows PowerShell 5.1 与 PowerShell 7；`.ps1` 文件保留 UTF-8 BOM，确保 Windows 自带 PowerShell 正确读取“录播机.exe”等中文路径。下载使用 `-UseBasicParsing`，不依赖 Internet Explorer 初始化。

1. 在源码的 `live-editor` 目录先执行 `. ./scripts/dev-env.ps1`，使当前进程的缓存和临时文件留在源码仓库 `.tools` 下；然后恢复依赖、运行 `npm test`、`npm run build`，构建 `desktop/build.ps1`。
2. 运行 `scripts/prepare-release-tools.ps1 -Destination <工具缓存>`。这只下载并解压开发用工具，不安装系统软件。固定版本和 SHA-256 校验防止静默换版。
3. 准备运行时目录中的 `node/node.exe`（Node 24.12.0）及自包含 .NET 8 录制核心 `recorder`。`-RuntimeRoot` 直接指向这个运行时目录；不指定时依次查找 `ProjectRoot/程序组件/runtime`、`ProjectRoot/runtime`、`ProjectRoot` 父目录的 `程序组件/runtime`。保留恢复过的 NuGet 缓存以收集许可。脚本不会运行现有录制服务，也不会打开现有用户数据库。
4. 在 PowerShell 中运行：

```powershell
./scripts/build-release.ps1 -ProjectRoot '<源码仓库根目录>' `
  -AppRoot '<最新 live-editor 源码目录>' `
  -DesktopRoot '<desktop/package 目录>' `
  -RuntimeRoot '<包含 node 与 recorder 的 runtime 目录>' `
  -ToolsRoot '<工具缓存>' -OutputRoot '<新的输出目录>' -Version '0.1.0'
```

输出目录中的版本目录和文件必须不存在；脚本不会覆盖已有版本，也不做递归删除。工具缓存默认 `ProjectRoot/.tools/release-tools`，构建目录默认 `ProjectRoot/.tools/release-work`。`DesktopRoot` 须使用当前桌面构建输出，其中配置和桌面 DLL 已位于 `程序组件`。输出包含 `.zip`、`.exe`、`.7z`、体积/哈希报告、未压缩工作目录；`程序组件/release-manifest.json` 记录版本与逐文件 SHA-256，所有路径仍相对于解压后的应用根目录。SFX 包的内容与 `.7z` 完全一致；外层 EXE 图标在追加归档前写入临时解压模板，不改变原始工具。

压缩使用 128 MiB LZMA2 字典，主要用于复用 FFmpeg 与 FFprobe 之间的重复数据；它增加的是解压期间约 128 MiB 级的字典内存，不改变软件运行时内存。压缩任务本身属于开发发布步骤，内存需求明显高于解压。没有使用启动时重复解压的单文件应用方案。

完成后分别运行 `scripts/test-release.ps1 -Package <ZIP或自解压EXE> -OutputRoot <新的测试解压目录>`，实际执行自解压、以 UTF-8 读取含中文路径的清单并核对每个文件的 SHA-256、检查顶层仅有四项、默认视频目录为空、没有未列出的文件和隐私数据，再验证随包 Node SQLite 与 FFmpeg 软件编码。新布局清单的 `layoutVersion` 为 2；验证脚本只接受当前的“程序组件”布局。录制、预览、三种导出模式和桌面启动仍需在隔离数据目录进一步冒烟；不要使用真实录像目录进行发布测试。

## 包含与排除

白名单包含桌面程序、WebView2 互操作 DLL、Node、录制核心的 DLL/EXE/runtimeconfig/deps、FFmpeg Essentials 的 ffmpeg/ffprobe、当前前端入口引用的资源、服务端 JS、许可证与依赖元数据。FFmpeg Essentials 保留 libass、libx264 以及 AMF/NVENC/QSV 接口；显卡是否可用仍由程序实际探测，失败时回退软件编码。没有删掉 CPU 回退功能来减少体积。

不包含录像、切片、导出文件、弹幕、用户配置、Cookie、数据库、日志、浏览器资料、node_modules、调试符号、旧前端 bundle、开发 SDK、FFplay。不可把运行中的项目根目录直接压缩上传。也不可把用户数据里的内部片段当作无用缓存删除。

当前发布脚本不裁剪录制核心的 .NET 程序集：反射、GraphQL 和动态序列化可能隐式使用它们；仅凭文件名删除容易使少见操作损坏。压缩和选择必要的 FFmpeg 构建能减少下载量，而不承担这些运行风险。

## 许可与公开发布

包内 `程序组件/LICENSE` 与 `程序组件/licenses` 保留项目 GPL-3.0、Node 及其第三方声明、对应 .NET 运行时声明、WebView2、Vue、Lucide、FFmpeg 和 7-Zip 许可，以及录制核心 NuGet 依赖的版本、作者、版权、许可文件/元数据。仍须在公开发布时提供本项目该版本的完整对应源码（包括录制核心改动与构建脚本）和 GPL 组件的对应源码获取渠道；仅放二进制或指向不对应版本的最新源码不够。本项目的发布仓库为 https://github.com/kk12091209/-；打包脚本只生成本地文件，不会自动上传。

脚本默认生成本地候选。公开构建必须额外传入 `-ForPublic -SourceUrl '<本项目该版本的完整源码归档或标签HTTPS地址>'`。脚本会拒绝缺失地址及直接把上游仓库当成修改版源码的做法；发布者仍须核实该地址确实包含完整且对应版本的源码、构建说明与依赖源码取得方式，不能把 URL 参数检查当成完整许可审计。

来源：

- BililiveRecorder：https://github.com/BililiveRecorder/BililiveRecorder
- Node 24.12.0：https://github.com/nodejs/node/tree/v24.12.0
- FFmpeg 8.1.2 Essentials：https://www.gyan.dev/ffmpeg/builds/ （具体编译配置、组件版本和源码 commit 在包内 README）
- 7-Zip 26.03：https://github.com/ip7z/7zip/releases/tag/26.03
- .NET 运行时：https://github.com/dotnet/runtime
- WebView2：https://developer.microsoft.com/microsoft-edge/webview2/
