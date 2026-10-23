# Website third-party notices

The website's original code follows the repository's GPL-3.0 license. Dependencies
retain their own licenses and notices. Exact versions and integrity hashes are
locked in `package-lock.json`; installed packages include their license texts.

| Dependency | License | Source |
| --- | --- | --- |
| React / React DOM | MIT | https://github.com/facebook/react |
| React Router | MIT | https://github.com/remix-run/react-router |
| Radix Icons | MIT | https://github.com/radix-ui/icons |
| Three.js | MIT | https://github.com/mrdoob/three.js |
| Mediabunny | MPL-2.0 | https://github.com/Vanilagy/mediabunny |
| fflate | MIT | https://github.com/101arrowz/fflate |
| Tencent COS Node SDK | ISC | https://github.com/tencentyun/cos-nodejs-sdk-v5 |

The browser user script retains its own metadata and copyright/license notices in
`public/plugins/`. FFmpeg is supplied by the deployment environment or the pinned
runtime image; its build configuration and applicable license must accompany any
redistribution. No FFmpeg executable or operating-system browser is checked into
this source directory.

## Homepage interaction attribution

The wave-grid interaction is inspired by [3D Wave Grid](https://github.com/franky-adl/3d-wave-grid) by franky-adl. This React adaptation uses bounded ripple propagation, shared instanced geometry, and the Caibao palette. The original license is retained below.

MIT License

Copyright (c) 2026 franky-adl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Downloader browser runtime

Playwright Core and its Docker seccomp profile are from Microsoft Playwright
1.64.1, licensed under Apache License 2.0. The license is retained in
`deploy/LICENSE.playwright.txt`. Source:
https://github.com/microsoft/playwright/tree/v1.64.1 .

`deploy/seccomp-browser.json` adapts the official
`utils/docker/seccomp_profile.json` by allowing `chroot` without the Docker
capability condition. This permits Chromium's own user-namespace sandbox when
the container drops all host capabilities. Chromium's sandbox remains enabled.
The pinned official image retains its browser and operating-system notices.

## Downloader image processing

Sharp 0.35.5 by Lovell Fuller and contributors is licensed under Apache License
2.0. Its license is retained in `deploy/LICENSE.sharp.txt`. Source:
https://github.com/lovell/sharp/tree/v0.35.5 . The installed native libvips
packages retain their bundled third-party notices and license texts.
