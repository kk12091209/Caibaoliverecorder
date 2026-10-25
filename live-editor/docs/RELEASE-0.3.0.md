# v0.3.0 — 弹幕样式修复与 B 站 Cookie 管理优化

Windows 与 Mac 同步更新至 0.3.0。

- 修复 Windows 覆盖升级后残留旧背景图，导致弹幕样式提示“预览背景未就绪”、无法保存的问题。按当前构建清单读取背景，预览异常时仍可保存有效设置。
- Cookie 管理仅保留 B 站。教程提供登录状态接口网址及“复制网址”按钮，复制请求标头中的完整 Cookie 值即可，无需手动拼接字段。
- 正常版本更新保留已保存的 B 站 Cookie 与系统密钥，不要求重新填写。Mac 如需钥匙串授权，可点击“解锁已保存的 Cookie”，继续使用原内容，旧值仍不可查看。
- 抖音继续免登录录制与获取弹幕昵称，移除账号 Cookie 填写入口；升级时清理旧版抖音 Cookie，保留 B 站 Cookie。
- 三种透明底时间戳的日期与时间统一字号，保留样式、位置和独立摄像头设置。时间戳仍仅用于本地预览。

## 安装与升级

- Windows 10 / 11 x64：提供中文安装包与 ZIP / 7z 便携包；安装版支持内置更新。
- Mac：Apple Silicon、macOS 14+，提供 DMG 与 ZIP。沿用 ad-hoc 签名，尚未完成 Apple 公证，暂不支持 Intel Mac。
- 正常内置更新或原位置覆盖安装保留录像、导出视频、设置及 B 站 Cookie。平台登录失效时才需要更换 Cookie；版本更新本身不会使其失效。
- 安装包和完整源码不包含本地开发 Cookie、系统密钥、个人录像或测试数据。

官网：https://www.caibao.media/works/caibo-recorder

两端使用同一源码提交构建，验证结果与校验值见发布附件。完整对应源码：https://github.com/kk12091209/Caibaoliverecorder/releases/download/v0.3.0/Caibo-0.3.0-complete-source.zip
