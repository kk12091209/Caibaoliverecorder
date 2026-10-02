# macOS runtime sources

The application retains the repository's GPL-3.0 license and upstream notices.
The macOS window uses Apple's system AppKit and WKWebView frameworks.

- Node.js 24.12.0 (arm64): https://nodejs.org/dist/v24.12.0/ . Source: https://github.com/nodejs/node/tree/v24.12.0 . Full Node and bundled dependency notices are in Node-LICENSE.txt.
- .NET 8 self-contained recorder: built from this repository's BililiveRecorder.Cli and referenced projects. Runtime notices ship in runtime/recorder; NuGet versions, source links, metadata and license files are in nuget-dependencies.json and nuget/. SDK 8.0.425 is a build dependency, not shipped to users.
- FFmpeg/FFprobe 9.0.2, Apple Silicon release build 1789931890_9.0.2 from https://ffmpeg.martin-riedl.de/ . Original binary URLs and SHA-256 are pinned in scripts/prepare-macos.sh. Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz . Build scripts: https://git.martin-riedl.de/ffmpeg/build-script . Exact dependency versions: ffmpeg-versions.txt. FFmpeg's COPYING.GPLv3 and LICENSE.md are included. The build contains libass and libx264 and is GPL-enabled.
- Vue and Lucide versions are recorded in editor-dependencies.json; license files are included alongside it.

Corresponding application source is published with the v0.1.4 release, including
submodule source, Swift shell, build scripts, Node service, UI and recorder changes:
https://github.com/kk12091209/Caibaoliverecorder/releases/tag/v0.1.4

The exact supplier configuration and dependency version inventory is included in
ffmpeg-versions.txt. FFmpeg and dependency upstream source locations are listed in
FFmpeg-SOURCES.md. The original supplier build scripts use a moving x264 master
archive, so the inventory does not assert bit-for-bit reproducibility of that
third-party binary. The app itself uses ad-hoc signing and is not Apple-notarized.
