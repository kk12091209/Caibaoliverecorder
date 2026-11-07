# 平台接入与协议覆盖

2026-11-07 本地开发记录。实现、协议夹具和实机验收分别记录。

## 小红书的当前实现

| 能力 | 实现与验证范围 |
| --- | --- |
| 视频 | 公开 H5 提供的 H.264 FLV，可匿名采集。此前 bb 直播短录约 7 秒，通过解码、预览和纯净导出 |
| 直播分享 | 整段分享文字、xhslink.com / xhslink.cn 及 www 短链、官方直播长链。每跳校验域名，核对房间与主播 UID |
| 主页 | 以 24 位稳定 UID 保存监控。公开页面受限时保留待确认目标，随后用登录会话核验身份 |
| 下一场直播 | 官方搜索页触发的 onebox / usersearch 响应，按目标 UID 精确匹配 live_info。获取新房间后再次核对 H5 房主 UID，再接入既有写盘模块 |
| 弹幕 | 登录后读取官方页面的 RWP WebSocket 文本事件。缺少可用 Cookie 时尝试匿名 H5 评论请求，访问限制会单独显示 |
| Cookie | 设置里提供小红书入口，要求 a1 和 web_session。加密保存、隔离上下文、低频失效检查及按凭据版本确认提醒复用现有机制 |
| 缺少 Cookie 的提示 | 添加小红书目标后显示用途说明，提供“我已知晓”和“去填写”，后者直接定位到小红书输入框 |
| 礼物、付费留言、连线跟录、独立摄像头 | 尚未接入 |

主页与小红书号分开处理。onebox 和 usersearch 中的同名用户不代替目标 UID，缺少 live_info、未知状态、冲突结果和访问错误保持待确认。只有明确状态 2 与有效房间才接入，状态 3 表示下播。新房间元数据还必须属于同一主播。正常录制时暂缓主页查询，待机目标每两分钟到期一次，每轮只查一个目标，轮次之间至少五秒。

弹幕只接纳 room 业务的 text 事件。载荷有房间标识时必须匹配目标，缺少标识时必须来自已经收到目标房间入房确认的连接。稳定消息 ID 用于去重，同名同文的不同事件保留。发送时间在合理范围内时用于定位，否则采用接收时间。消息采样、长消息规则与其他平台共用，XHS 的 24 位发送者 ID 单独校验。

## 网页会话与资源边界

后台使用本机 Chrome 或 Edge，经继承管道通信，浏览器配置独立，不读取用户原有浏览器目录。Cookie 从安全存储送入无痕上下文，由官方网页完成签名、令牌与 RWP 认证。浏览器不承担视频写盘，FLV / HLS / MP4 等媒体请求被阻止；默认最多四个小红书弹幕页面，并尝试降低浏览器进程优先级。删除或确认失效的 Cookie 后关闭该会话，视频仍由原写盘模块持续采集。

每个网页连接有超时，API / WebSocket 数据限制为 512 KiB，房间事件批次最多 200 项。访问受限后退避，HTTP 403 / 406 / 429、超时和网页风险页均不会被判定为 Cookie 失效。失效必须来自本人状态的明确未登录响应。原始凭据和请求签名不会进入日志、普通设置、命令参数或网页地址。

弹幕写入失败时保留有界待写批次重试，XML 的部分尾部先回滚。若无法回滚则停止这一路 XML 写入并保留故障状态，健康的视频写入继续。退出、切换 Cookie、停止和移除操作都等待各自会话收尾；旧查询结果不能重新开启已停止的目标。

## 已核对格式与回归样本

| 平台 | 格式与边界 | 主要测试入口 |
| --- | --- | --- |
| B 站 | 分享/数字房间查找、WebSocket 认证与重连、普通弹幕/礼物/SC、SEI 多人布局第 17 版内置视频布局、MULTI_SCREEN 明确源裁剪 | room-lookup、danmaku-connection-integration、gifts（含SC）、linkmic、recording-style |
| 抖音 | 本人/主页/连线发现、旧版名单与 v3 补查、WebSocket protobuf、SEI 2/6/15、旧 game_clip/camera_clip、新 multi_view_data 对象与 JSON、横竖布局及同角色新显示编号 | douyin-user-discovery、douyin-linkmic-roster、douyin-user-follow、douyin-protocol、recording-style |
| 小红书 | H5 状态对象、精确 uint64 房间号、短链/主页、onebox/usersearch、RWP JSON/base64/customData、显式房间/已确认频道路由、Cookie 更新和匿名回退 | xiaohongshu、xiaohongshu-web、platform-credentials、platform-cookie-validation |

每次新增结构必须补充脱敏夹具，覆盖身份冲突、字段缺失、未知状态、无效裁剪、访问限制和迟到响应。链接、状态、消息和编码能力分别核对。当前编辑链路采用兼容的 H.264/AAC FLV，公开数据未提供该格式时明确报告，不能把 H.265 或 HLS 地址直接传入 FLV 规范化器。旧素材缺少来源或布局字段仍保留兼容读取。

## 源码核对来源

- [DDBOT-WSa 的 XHS 客户端](https://github.com/cnxysoft/DDBOT-WSa/blob/next-dev/lsp/xhs/client.go)及[订阅实现](https://github.com/cnxysoft/DDBOT-WSa/blob/next-dev/lsp/xhs/concern.go)。核对稳定 UID、搜索 live_info 与状态含义。
- [catbus 的 RWP 实现](https://github.com/cv-cat/catbus/blob/master/src/platforms/xhs/web/push.ts)及[HTTP 接口](https://github.com/cv-cat/catbus/blob/master/src/platforms/xhs/web/api.ts)。核对握手、入房确认与 room 事件。
- [小红书直播扩展的页面采集实现](https://github.com/llg1634/xhs-live-recorder-extension/blob/main/extension/content_final_main.js)。核对网页 WebSocket 文本事件、发送者与时间字段。
- [小红书官方当前直播间接口文档](https://miniapp.xiaohongshu.com/doc/DC259509)需要小程序 app_id 与 access_token，参数中未提供任意用户 UID 查询。用户主页监控采用官方网页实际触发的接口。
- [小红书 deeplink 文档](https://pages.xiaohongshu.com/activity/deeplink)、[B 站布局接口](https://api.live.bilibili.com/xlive/web-room/v2/universalInteract/LayoutData?platform=pc)、[B 站官方播放器](https://s1.hdslb.com/bfs/blive-engineer/live-web-player/room-player.prod.min.js)及[抖音官方播放器入口](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/client-entry~1.221bb38d.js)。布局细节见 [LINKMIC.md](LINKMIC.md)。

## 本轮验证与缺口

受控协议与浏览器事件验证覆盖入房确认、消息路由、重复文本、写入失败、下一场房间替换、停止后迟到结果、三平台加密存储与重启。真实 FFmpeg 连续视频用于界面检查，确认提示、跳转、保存及移除 Cookie 时同一来源文件持续增长。macOS 安全存储助手已编译通过。

当前没有有效的小红书账号 Cookie。公开 H5 评论请求实测 HTTP 406，官方桌面页也出现访问限制。因此真实账号 RWP 消息、真实下一场开播、长期运行和 Windows 实机仍待验证，受控测试不能替代这些验收。
