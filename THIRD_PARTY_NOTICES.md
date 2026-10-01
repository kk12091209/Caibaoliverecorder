# 第三方组件与对应源码

菜播·录包机是在 BililiveRecorder 基础上开发的独立工作台。项目许可为 [GPL v3](LICENSE)，上游版权及文件头保留。修改版源码和构建脚本随本仓库发布；每个运行包的 release-manifest.json 指向同一版本的源码标签。不要把上游未修改的源码作为本项目的对应源码。

| 组件 | 版本 / 来源 | 源码与许可位置 |
| --- | --- | --- |
| BililiveRecorder 基线 | a27640a33bcc35e09c76111c14e1d3627805e483 | [上游](https://github.com/BililiveRecorder/BililiveRecorder/tree/a27640a33bcc35e09c76111c14e1d3627805e483)，修改后的文件在本仓库；GPL v3 |
| Node.js | 24.12.0 | [源码与第三方声明](https://github.com/nodejs/node/tree/v24.12.0)；包内 licenses/node |
| FFmpeg | 8.1.2，菜播精简共享库构建 | [确切源码提交](https://github.com/FFmpeg/FFmpeg/commit/38b88335f9)、[本项目构建脚本](live-editor/scripts/build-ffmpeg.ps1)、[MSYS2 依赖源码](https://github.com/msys2/MINGW-packages)；包内 licenses/ffmpeg 的 README.txt / LICENSE，GPL v3 |
| 7-Zip | 26.03 | [对应版本源码](https://github.com/ip7z/7zip/tree/26.03)；包内 licenses/7zip，按其 LICENSE 中各部分条款 |
| Inno Setup | 6.7.3 | [对应版本源码](https://github.com/jrsoftware/issrc/tree/is-6_7_3)；安装版额外包含 licenses/Inno-Setup-LICENSE.txt |
| 安装器简体中文翻译 | 1ff90acc4ed4aee82b1cda43253243deee3daed4 | [翻译来源](https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation/tree/1ff90acc4ed4aee82b1cda43253243deee3daed4)，MIT；源码 installer/translation-LICENSE.txt，安装版 licenses/installer-translation-LICENSE.txt |
| Inno Setup | 6.7.3 | [对应版本源码](https://github.com/jrsoftware/issrc/tree/is-6_7_3)；安装版额外包含 licenses/Inno-Setup-LICENSE.txt |
| 安装器简体中文翻译 | 1ff90acc4ed4aee82b1cda43253243deee3daed4 | [翻译来源](https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation/tree/1ff90acc4ed4aee82b1cda43253243deee3daed4)，MIT；源码 installer/translation-LICENSE.txt，安装版 licenses/installer-translation-LICENSE.txt |
| Vue / Lucide | 锁定版本见 live-editor/package-lock.json | [Vue](https://github.com/vuejs/core)、[Lucide](https://github.com/lucide-icons/lucide)；包内 licenses/frontend |
| 抖音 HTTP 签名互操作算法 | 2026-10-01 适配 | 从 [ihmily/streamget](https://github.com/ihmily/streamget/blob/main/streamget/platforms/douyin/ab_sign.py) 移植为本地 JavaScript，MIT；完整许可保存在 live-editor/docs/licenses/streamget-MIT.txt，运行包 licenses/douyin |
| 抖音 WebSocket 签名互操作算法 | native.go SHA-256 `faa39870efd791f02ee3881abb7a4bea2292c34508a294106cb3fcec06542a28` | 从 [jwwsjlm/douyinLive](https://github.com/jwwsjlm/douyinLive/blob/main/internal/webcastsign/native.go) 移植，MIT；保留原作者许可 live-editor/docs/licenses/douyinLive-MIT.txt，运行包 licenses/douyin。未内嵌浏览器签名 SDK |
| WebView2 SDK | 1.0.4191.47 | [微软 SDK 许可与说明](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4191.47)；runtime/desktop 内 LICENSE / NOTICE |
| .NET 与 NuGet 依赖 | 精确版本见发行包清单及依赖元数据 | [dotnet/runtime](https://github.com/dotnet/runtime)、[dotnet/aspnetcore](https://github.com/dotnet/aspnetcore)；licenses/dotnet 与 licenses/nuget |

录制核心 NuGet 依赖的包版本、作者、版权、许可表达式、仓库地址和可用的源码提交号保存在运行包的 licenses/nuget/dependencies.json；同时保留 NuGet 元数据与其提供的许可文本。FFmpeg 的构建配置及所启用的库见随包 README。第三方源码不嵌入运行包，按上述对应版本取得；重新分发者应保留这些声明并履行相应许可义务。

发布工具的固定下载地址及 SHA-256 在 live-editor/scripts/prepare-release-tools.ps1 和随包 licenses/download-sources.json 中。WebView2 Evergreen、.NET Framework 属于用户系统先决条件，不随便携包重新分发。
