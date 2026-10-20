# 连麦主播名牌

连麦时，在每位主播自己的画面右下角显示小号白字和阴影，优先显示昵称，缺少昵称时显示能够确认的用户 ID / 连麦编号。名牌与弹幕开关、展示区域无关，预览、纯净版、弹幕版和双文件导出均保留；原始 FLV 不重编码、不改写。需要烧入名牌的纯净版会编码导出，不能直接复制视频码流。

## 数据来源和定位

- B 站：读取 H.264 SEI type 5 的 `LIVE_SEI_CHANNEL` / `LIVE_MULTI_VIDEO_LINK`。用 `members.position` 匹配 `interact_template.layout_data.cells.position`，按 layout 的宽高归一化坐标；不按成员数组顺序、不按人数猜测分区。姓名取 `uname`，ID 优先用字符串字段。空座位不标注。
- 抖音：读取 SEI type 100 的 `app_data`，支持平台当前双人 `ver=2` 和多人 `ver=6` 的明确矩形。双人模式使用 `live_crop.crop_y/crop_h/stride_h` 定位真实视频中的连麦区，保留原始上下留白。通过匿名访客 `GET /webcast/linkmic/list/` 获取名单，以同一频道的 `linkmic_id_str` 精确匹配 `grids.uid_str`。双人协议仅发送远端矩形，本房主播按该协议的左右各半布局补在左侧，身份来自本次录制的房间信息。游戏画面/摄像头复合裁剪尚不标注。
- 抖音普通观众上麦：已实测 `ver=15 / interactive_scene=8 / ui_layout=7` 的右下角悬浮小窗，视频与语音用户均可标注。`p=-1` 为本房主播，`p=0..5` 为从下向上的小窗；读取 `GET /webcast/linkmic_audience/list/v2/` 名单，仍以连麦 ID 匹配身份，不用名单顺序或 `user_position` 推测 SEI 座位。尺寸依据平台 [VideoRoom 布局样式](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/client-entry~1.bc037bea.css) 中 `HLzCnPol`，并与原始录像、网页边界交叉核对。语音麦位（`grids.type=2`）补充圆形抖音头像、半透明深灰背景与昵称；切回视频（`type=1`）立即去掉头像卡片，换位按 SEI 时间轴同步。头像读取同一用户的 `avatar_medium / avatar_thumb`。不通过画面内容推测摄像头状态，不覆盖主主播或视频麦位。礼物计分、动画及其他观众布局尚未重建。
- 浏览器 letterbox 与导出跨画幅的 letterbox 在最后一步计算。长昵称限制在自己的分区内；窄屏预览设可读字号下限，分区太小时仍受分区大小约束。

字段依据：2026-10-20 对用户提供的两个公开直播间进行短时读取，直接核对平台返回的 SEI 和名单；抖音当前[官方 PK SEI 组件](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/PKSEIPlugin.156e90d3.js)、[官方 PK 展示与名单请求组件](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/chunks/PKViewPlugin.de2e4662.js)、[官方版本枚举](https://lf-webcast-platform.bytetos.com/obj/webcast-platform-cdn/webcast/douyin_live/client-entry~1.28f20eec.js)可交叉核对。接口与格式可能变化，未知数据不推测坐标。

同日追加核对用户提供的普通观众上麦房间 `118181154061`，保留三人同麦与其中一人下麦后其余用户座位下移的实录。搜索页与分类页链接中明确的 `live_web_rid` 现在也可直接识别，重复或无效房间参数仍拒绝。

## 保存、回放与兼容

索引保存 SEI 对应的视频时间与明确布局，重复布局只延长有效区间。换人、换位、结束立即更新；连续 6 秒没有相关 SEI 时旧名牌过期，避免断流或未知布局长期挂错名字。抖音名单请求与视频读取独立，最多每频道 15 秒刷新一次，失败不影响录制，下次重试。

名牌索引、最小身份映射和语音用户的头像保存在素材数据库，删除素材时一起删除。头像只从允许的抖音图片 CDN HTTPS 地址获取，不携带访客 Cookie、不跟随重定向，限制下载大小和解码像素，转换为 128×128 的圆形透明 PNG 后按内容哈希保存。预览和各类导出使用同一份本地图像，离线仍可显示；头像请求失败不阻断录制和名牌显示。不会保存访客 Cookie、远端头像 URL、CDN 签名和其他用户资料。导出入队时冻结名牌时间轴和头像引用；缓存键包括名牌、摄像头状态、头像哈希与时间，旧缓存不会覆盖新显示。

旧素材在选择预览或导出时读取保留的原片/内部片段，B 站可以从内嵌 SEI 恢复姓名。旧抖音素材如果从未保存连麦名单，只能恢复 SEI 中的编号和坐标；不会拿当前直播间的名单猜测历史人物。已经导出的旧视频不自动改写。

测试包括平台载荷解析、多人空位、无效布局、uint64 ID、断流过期、旧素材恢复、重启、分区裁剪、头像下载边界、素材隔离与删除，以及真实 FFmpeg 像素检查：纯净/弹幕/双文件与预处理导出、名字生效和消失时间、头像换位、开启摄像头后去除头像、缓存失效。旧抖音素材没有保存头像时不会用今天的直播名单补猜；本地演示实录的头像来自同一次连麦保存的名单。
