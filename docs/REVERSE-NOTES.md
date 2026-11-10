# B 站手机版「听视频」拆包逆向笔记

目标 APK：`apk\bilibili-latest.apk`（tv.danmaku.bili v8.91.1，versionCode 8911100，182.9 MB，SHA-256 `e6f1adee9b96ce9eb79001f27ab0688b5c1712f3c635bc9d6e2db82d1a9c30c8`）

> 顺带对照了本机另一份 `A:\Work\Astrbot\apks\bilibili.apk`（v9.10.0），类名/接口完全一致，只是版本号更高。

> **本文每条结论的 smali 原文证据在 [APK-SMALI-EVIDENCE.md](APK-SMALI-EVIDENCE.md)**，路径精确到 `.method`，可直接复现核对。

## 1. 结论：手机版「听视频」到底是个什么功能

它不是一个独立 App，而是 B 站主 App 内的一个**音频化的视频播放器**（内部代号 `music_podcast`），核心特征：

| 能力 | 手机版实现 |
|---|---|
| 内容形态 | 普通 UGC 视频（`PlayItem.item_type=2`）+ OGV（`item_type=1`）+ 音频稿件（`item_type=3`）三类混排 |
| 播放内核 | 同一套 IJK 播放器，但只取 **DASH 的音频轨**（`PlayDASH.audio[]`），不拉视频轨，省流量 |
| **为什么真的省流量** | `app.listener.v1.PlayDASH` 这个 proto **只有 `audio_` 一条轨**（对比标准 `app.playurl.v1.ResponseDash` 有 `VIDEO=1`/`AUDIO=2` 两条），schema 层面就削掉了视频轨 |
| 后台播放 | `tv.danmaku.bili.ui.player.notification.BackgroundMusicService`（`foregroundServiceType=mediaPlayback`，独立前台服务） |
| 通知栏 | 自定义 RemoteViews，action 前缀 `com.bilibili.player.music.notification.*`：`play` / `pause` / `play.pause` / `prev` / `next` / `stop` / `fast_forward` / `rewind` / `like` / `unlike` / `delete` / `toggle_mode` |
| 播放列表 | `PlaySet`（播单）+ `FavFolder`（收藏夹）+ `PlayHistory`（最近在听）三套数据源，服务端 gRPC |
| 倍速 | `PodcastSpeedSeekBar`，档位数组反编译原文 `.array-data 4 { 0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f }`（**6 档，没有 1.75，有 0.5**）；布局 `music_podcast_dialog_player_setting.xml` 写死 `app:spSelectDefaultIndex="2"` → 默认 **1.0×** |
| 播放模式 | `music_podcast_dialog_player_setting.xml` 的 `mode_setting_title` + 2 列 `RecyclerView`：顺序 / 循环 / 单曲 / 随机 |
| 定时关闭 | `music_podcast_super_menu_dialog_timing_item`（超级菜单里的「定时关闭」） |
| 界面骨架 | 底部迷你播放条 `music_podcast_bottom_play_view.xml` + 全屏播放页 `music_podcast_fragment_play.xml` + `music_podcast_include_play_panel.xml`（封面/标题/进度/控制区） |

关键类（全部在 `com.bilibili.music.podcast` 包下）：

```
MusicPodcastMainActivity              主界面（听视频 Tab）
MusicPodcastPlayListActivity          播放列表
MusicPodcastFindAllListActivity       发现-全部
MusicPodcastCardTransferActivity      卡片转场
fragment/MusicPodcastFindFragment     发现页
fragment/MusicPodcastRecommendMainFragment  推荐主页
fragment/MusicPodcastHistoryFragment  最近在听
fragment/MusicPodcastPlayListFragment 播单详情
fragment/MusicPodcastUpperFragment    UP 主稿件
collection/MusicPodcastPrimaryFavFragment    我的收藏（一级）
player/resolve/MusicPodcastResolver   播放地址解析器
player/resolve/MusicPodcastResolverParams    解析参数（Parcelable）
moss/MusicMossApiService              gRPC-Moss 业务接口封装
```

## 2. 播放链路（核心）

`MusicPodcastResolver.requestPlayView()` 反编译原文：

```java
private final PlayURLResp requestPlayView(MusicPodcastResolverParams params) throws MossException {
    long oid = params.getOid();
    return new ListenerMoss(null, 0, null, 7, null).executePlayURL(
        PlayURLReq.newBuilder()
            .setItem(PlayItem.newBuilder()
                .setItemType(params.getType())   // 1=OGV 2=UGC 3=音频
                .setOid(oid)                     // aid / season_id / song_id
                .addSubId(params.a())            // cid
                .build())
            .setPlayerArgs(MusicMossApiService.a().u())  // PlayerArgs
            .build());
}
```

对应 gRPC 服务：`bilibili.app.listener.v1.Listener/PlayURL`（Moss 长连接通道，protobuf）。

响应结构（从 `com.bapis.bilibili.app.listener.v1.PlayURLResp` / `PlayInfo` 反编译）：

```
PlayURLResp {
  item: PlayItem
  playable: int          // 0=可播
  message: string
  player_info: map<int64, PlayInfo>   // key = qn（音质档位）
}
PlayInfo {
  qn: int; format: string; qn_type: int
  info_case: PLAY_URL | PLAY_DASH
  play_dash: PlayDASH { audio: [DashItem{qn, bandwidth, codecs, base_url, backup_url, mime_type, ...}], duration }
  play_url:  PlayURL { durl[] }
  fnval, fnver, formats[], video_codecid, length, code, message, expire_time
}
```

`MusicPodcastResolverParams` 字段（混淆后 `a`~`j`，反编译 `MusicPodcastResolverParams.smali` 的 `.field` 列表）：
`a:I`（cid / subId，`a()` 取值）、`b:I`、`c:J`、`d:J`、`e:I`、`f:I`、`g:I`、`h:I`、`i:J`、`j:J`。
对外暴露的 getter：`getOid()J`、`getType()I`（1=OGV / 2=UGC / 3=音频稿件）。

播放地址解析的 `PlayerArgs`（`MusicMossApiService.u()` 反编译原文）：

```java
PlayerArgs.newBuilder()
  .setQn(0x40)                                   // 64 = 请求 DASH 音质档位元数据
  .setFnver(PlayUrlFlagsManager.getFnVer())
  .setFnval(PlayUrlFlagsManager.getFnVal())
  .setSoftFnval(PlayUrlFlagsManager.getSoftFnVal())
  .setForceHost(PlayerSettingHelper.getForceHost())
  .setVoiceBalance(IjkOptionsHelper.getVolumeBalance() ? 1 : 0)
  .build();
```

`MediaResource` 组装（`MusicPodcastResolver$a.e()`）：只遍历 `PlayDASH.getAudioList()` 的 `DashItem`，逐个塞进 `DashMediaIndex`：
`a=id(qn)`、`p(backupUrlList)`、`c=baseUrl`、`e=bandwidth`、`f=codecid`、`v(md5)`、`g=size`；
音频列表为空直接抛 `ResolveInvalidCodeException("MusicResolver:resolve fail, audio list is empty", -8)` —— **确认只拉音频轨，不碰视频轨**。

**桌面端等价实现**：Web 端有同一套 playurl 网关的 REST 版本，语义一致（都是 DASH）：

```
GET https://api.bilibili.com/x/player/wbi/playurl
    ?bvid=BVxxx&cid=123&fnval=4048&fnver=0&fourk=1&platform=pc   (+ wbi 签名)
→ data.dash.audio[] { id, baseUrl, backupUrl[], bandwidth, codecs, mimeType }
```

`fnval=4048` 位掩码 = DASH(16) + HDR(64) + 4K(128) + 杜比音频(256) + 杜比视觉(512) + 8K(1024) + AV1(2048)。实测可用。

音质档位 `dash.audio[].id`：

| id | 码率 | 说明 | 编码 |
|---|---|---|---|
| 30216 | 64K | 流畅 | AAC |
| 30232 | 132K | 标准 | AAC |
| 30280 | 192K | 高（默认） | AAC |
| 30250 | — | 杜比全景声 | EC3（需大会员） |
| 30251 | — | Hi-Res 无损 | FLAC（需大会员） |

## 2.5 登录：三套方案（实测结论）

| 方案 | 接口/机制 | 实测结果 |
|---|---|---|
| **TV 端扫码（主推）** | `POST /x/passport-tv-login/qrcode/auth_code` + `/poll` | ✅ 二维码生成正常，轮询返回 `86039 等待` |
| 网页登录（内嵌窗口） | ~~`BrowserWindow` 内嵌 passport~~ 已移除：改为拉起系统默认浏览器登录 + 本地回环回传服务（`services/browser-login.js`，书签 bookmarklet 把 `document.cookie` 发回 `127.0.0.1:45872/cb`，主进程 checkLogin 校验后落盘） | ✅ 回传链路验证通过 |
| 手动 Cookie | `document.cookie` 粘贴 + `/x/web-interface/nav` 校验 | ✅ 兜底方案 |

### TV 扫码接口细节（这套是桌面/TV 端的正解）

```
POST https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code
  body: appkey=4409e2ce8ffd12b8&local_id=0&ts=<秒>&sign=<md5>
  → { code:0, data:{ url, auth_code } }

POST https://passport.bilibili.com/x/passport-tv-login/qrcode/poll
  body: appkey=...&local_id=0&auth_code=...&ts=<秒>&sign=<md5>
  → code 0     = 登录成功，data.cookie_info.cookies[] 直接给 Cookie
  → code 86039 = 二维码尚未确认（未扫码）
  → code 86090 = 已扫码，等手机端点确认
  → code 86038 = 二维码已失效
```

签名算法：参数按 key 字典序 → `k=urlencode(v)` 拼 `&` → 末尾直接接 `APPSEC` → MD5。

```
APPKEY = 4409e2ce8ffd12b8
APPSEC = 59b43e04ad6965f34319062b478f83dd
```

> 这是 B 站 TV 客户端（云视听小电视）内置的公开常量，逆向 APK 的 `com.bilibili.tv` 相关类可得。
> 走这套接口等同于在电视上登录，Cookie 由官方下发，全程不接触用户密码。
> 二维码 URL 指向 `passport.bilibili.com/x/passport-tv-login/h5/qrcode/auth?auth_code=...`，手机 B 站 App 扫码后点确认即可。

### 为什么主推扫码而不是内嵌网页

1. 内嵌 `passport.bilibili.com` 的登录页依赖大量风控脚本和 iframe（`s1.hdslb.com/bfs/seed/jinkela/short/cols/iframe.html`），Electron 环境下能跑但不稳定
2. 网页登录成功后不一定会跳转，Cookie 只在 XHR 里种下，只能靠轮询 `session.cookies` 兜底
3. 扫码是 TV 端原生流程，二维码画在自己应用里，体验和 B 站 TV 版一致

## 3. 鉴权与防盗链
- Web API 需要 `wbi` 签名：`wts` 时间戳 + 按 key 排序的 query，拼 `mixinKey(img_key + sub_key)` 后 MD5 得 `w_rid`。
  `mixinKey` 用固定 64 位置换表 `MIXIN_KEY_ENC_TAB` 取值前 32 位。img/sub key 从 `x/web-interface/nav` 的 `wbi_img` 取。
- 音频 CDN（`*.bilivideo.cn:8082` / `*.hdslb.com`）校验 `Referer: https://www.bilibili.com/` 和 UA，**不校验 cookie**（部分版权内容会校验）。
- 播放地址有效期约 90 分钟（`PlayInfo.expire_time`），过期需重新调 playurl。

> 这就是桌面端必须内置本地代理的原因：`<audio src>` 无法自定义 Referer。

## 4. UI 信息架构（照抄手机版，改桌面布局）

```
┌──────────────────────────────────────────────────────────────┐
│ 标题栏（自绘，无边框）  ● 搜索框            ─  □  ×          │
├────────┬─────────────────────────────────────────────────────┤
│ 侧边栏  │  内容区                                             │
│ 发现    │  ┌─────┬─────┬─────┬─────┐  卡片网格                │
│ 排行    │  │封面 │     │     │     │                          │
│ 搜索    │  └─────┴─────┴─────┴─────┘                          │
│ 收藏    │                                                     │
│ 历史    │                                                     │
│        │                                                     │
├────────┴─────────────────────────────────────────────────────┤
│ 底部播放条：封面｜标题/UP｜⏮ ⏯ ⏭｜进度条｜时间｜音量｜倍速｜队列｜词 │
└──────────────────────────────────────────────────────────────┘
```

全屏「正在播放」页（点封面展开）：

```
        ┌───────────────────────────┐
        │                           │
        │        大封面（旋转唱片）    │
        │                           │
        └───────────────────────────┘
             标题（大字）
             UP 主 · 播放量
     ─────────●──────────────────────
     01:23                        04:56
        ⏮    ⏯    ⏭      🔁   🎚   ⏰
```

## 5. 从手机版抄过来的功能清单

- [x] 纯音频播放（不拉视频流，省 90% 流量）
- [x] 后台/托盘常驻播放（对应 BackgroundMusicService）
- [x] 全局媒体键（MediaPlayPause / Next / Prev）
- [x] 通知栏等价物 → Windows 托盘 tooltip + 右键菜单
- [x] 播放列表 / 队列（顺序、循环、单曲、随机）
- [x] 倍速 0.75×–2.0×
- [x] 定时关闭（15/30/60/90 分钟、播完当前）
- [x] 最近在听（本地历史 + 服务端历史）
- [x] 收藏夹（登录后）
- [x] 分P 支持（一个视频 150 个分P 就是 150 首"歌"）
- [x] 相关推荐自动连播（对应「后台播放时自动连播相关视频」）
- [x] 搜索
- [x] 排行榜（音乐区 rid=3）
- [ ] 弹幕（听视频用不上，砍掉）
- [ ] 投币/点赞（桌面端简化，仅保留外链打开原视频）
