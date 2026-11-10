# BiliListen · 哔哩哔哩「听视频」桌面版

把 B 站手机客户端的「听视频」功能搬到 Windows 桌面上：**只拉音频流，不拉视频流**，省流量、省电、能后台挂着当音乐播放器用。

```
E:\rea\bili-listen\
├── apk\bilibili-latest.apk        # 拆包目标（B 站 Android v8.91.1）
├── decoded\apktool\               # apktool 解包产物（资源/Manifest）
├── decoded\smali\                 # baksmali 产物（38 个 dex → 521 个 podcast smali）
├── dexstrings.txt                 # 全部 38 个 DEX 的字符串导出（2,579,504 条）
├── docs\
│   ├── REVERSE-NOTES.md           # ★ 逆向笔记：听视频到底怎么实现的
│   ├── APK-SMALI-EVIDENCE.md      # ★ 证据附录：每条结论对应的 smali 原文
│   ├── FRONTEND-SPEC.md           # 前端开发规格（交给子代理的）
│   └── UI-REFERENCE.md            # 手机版控件树 → 桌面端映射
└── app\                           # 桌面应用
    ├── electron\
    │   ├── main.js                # 主进程：窗口/托盘/媒体键/IPC
    │   ├── preload.js             # contextBridge 暴露 window.bili
    │   └── services\
    │       ├── bili.js            # B 站 API 封装（wbi 签名 / playurl / 字幕）
    │       ├── proxy.js           # 本地音频代理（补 Referer + Range 透传）
    │       └── tv-login.js        # TV 端扫码登录
    ├── src\                       # 前端（glm-5.3-flash 子代理实现）
    │   ├── index.html
    │   ├── styles\                # base / layout / components / supplement
    │   └── js\
    │       ├── app.js             # 入口
    │       ├── api.js             # window.bili 封装
    │       ├── store.js           # 全局状态 + localStorage
    │       ├── player.js          # 音频播放内核
    │       ├── router.js          # hash 路由
    │       ├── utils.js           # el() / 格式化 / 二分查找
    │       ├── debug-bridge.js    # CDP 自动化句柄（window.__bili）
    │       ├── views\             # discover/ranking/search/favorites/history/nowplaying
    │       └── components\        # titlebar/sidebar/playbar/queue/card/toast/modal
    ├── scripts\
    │   ├── launch.js              # 启动器（清 ELECTRON_RUN_AS_NODE）
    │   ├── build.js               # 打包脚本
    │   ├── verify.js              # CDP 自动化验收（10 项）
    │   ├── verify-settings.js     # 设置页验收（11 项）
    │   ├── verify-packaged.js     # 打包版验收（9 项，连已启动的 exe）
    │   └── verify-login.js        # 登录专项验收（8 项）
    ├── start.bat                  # 双击启动
    └── package.json
```

## 快速开始

```powershell
cd E:\rea\bili-listen\app
npm start          # 或双击 start.bat
```

> **坑**：本机全局环境变量 `ELECTRON_RUN_AS_NODE=1`，直接跑 `electron.exe` 会让它退化成纯 Node 进程（`app` 是 undefined）。`start.bat` 和 `scripts/launch.js` 都会先清掉它。

## 自动化验收

```powershell
cd E:\rea\bili-listen\app
node scripts\verify.js
```

用 CDP 连进渲染进程，10 项全过（实测 10/10）：

```
PASS  1. 窗口启动无白屏
PASS  2. 发现页真实卡片（20 张）
PASS  3. 点卡片能播放（静音，本地代理出流）
PASS  4. 倍速可控
PASS  5. 主题切换
PASS  6. 控制台无 error
PASS  7. 排行榜渲染（30 行 5 Tab）
PASS  8. 搜索出结果
PASS  9. 全屏播放页展开（黑胶 spin 动画）
PASS 10. 队列抽屉打开
```

### 三套补充验收脚本

| 脚本 | 覆盖 | 实测 |
|---|---|---|
| `node scripts\verify-settings.js` | 发现页骨架卡清理 / 设置页 7 行 / 音质·倍速·托盘三项落盘 | **11/11** |
| `node scripts\verify-packaged.js` | **打包版**（自动启动 `dist\BiliListen.exe`，验完自动关）：卡片/播放/6 档倍速/队列/全屏/倍速菜单/设置页 | **9/9** |
| `node scripts\verify-login.js` | 扫码二维码生成 / 轮询 / 网页登录 IPC / Cookie 校验 / 三 Tab 弹层 | **8/8** |

> **测试全程静音 + 不弹窗**：`verify.js` 启动参数带 `--mute-audio --hidden`，主进程 `isHidden` 分支不调用 `win.show()`，任务栏都看不到窗口。
>
> 本机另有两个坑：全局环境变量 `ELECTRON_RUN_AS_NODE=1`（不清会让 electron 退化成纯 Node）、GPU 进程崩溃 `exit_code=-1073740791`（加 `--disable-gpu`）。

## 打包

```powershell
cd E:\rea\bili-listen\app
node scripts\build.js
# 产物：E:\rea\bili-listen\dist\BiliListen-win32-x64\  (213.8 MB)
```

产物已实测可启动（`verify-packaged.js` 9/9）：20 张卡片、点播出声、图片代理 200/41KB、6 档倍速、全屏播放页、设置页完整。

---

## 一、逆向：手机版「听视频」是怎么做的

完整笔记见 [REVERSE-NOTES.md](docs/REVERSE-NOTES.md)，这里只摘结论。

### 1.1 它不是独立功能，是 `music_podcast` 模块

包名 `com.bilibili.music.podcast`，**521 个 smali 文件**（`view/` 121 + `fragment/` 116 + `utils/` 96 + `collection/` 56 + `data/` 51 + `legacy/` 43 + `moss/` 18 + `player/` 8 + 根级 12），含 8 个 Activity，加上 `tv.danmaku.bili.ui.player.notification.BackgroundMusicService`（前台服务，`foregroundServiceType=mediaPlayback`）。

深链入口：`bilibili://music` / `bilibili://podcast`（Manifest 里两条 `<data>`），说明它是可独立跳转的业务模块。

### 1.2 播放链路

```
MusicPodcastResolver.requestPlayView(params)
  → ListenerMoss.executePlayURL(PlayURLReq)
  → gRPC: bilibili.app.listener.v1.Listener/PlayURL
  → PlayURLResp{ playable, player_info: map<cid, PlayInfo> }
  → PlayInfo.play_dash.audio[]  ← 只播这个，不碰 video[]
```

**关键发现：`app.listener.v1.PlayDASH` 这个 proto 里根本没有视频轨字段。**
同一 APK 里的标准播放接口 `app.playurl.v1.ResponseDash` 有 `VIDEO=1 / AUDIO=2` 两条轨，它的 `DashItem` 还带 `FRAME_RATE=8` 和 `WIDEVINE_PSSH=9 / BILIDRM_URI=10`（DRM）；而听视频专用的 `PlayDASH` 只有 `AUDIO=3 / DURATION=1 / MIN_BUFFER_TIME=2` 三个字段，`DashItem` 也没有帧率和 DRM 字段。

也就是说「省流量」不是靠"拉了视频不看"，而是**服务端在 protobuf schema 层面就把视频轨削掉了**，客户端连想拉都拉不到。这是本次逆向最有价值的一条结论，证据在 [APK-SMALI-EVIDENCE.md](docs/APK-SMALI-EVIDENCE.md) 第 2.3.1 节。

反编译原文（`com.bilibili.music.podcast.player.resolve.MusicPodcastResolver`）：

```java
private final PlayURLResp requestPlayView(MusicPodcastResolverParams params) throws MossException {
    long oid = params.getOid();
    return new ListenerMoss(null, 0, null, 7, null).executePlayURL(
        PlayURLReq.newBuilder()
            .setItem(PlayItem.newBuilder()
                .setItemType(params.getType())   // 1=OGV 2=UGC 3=音频稿件
                .setOid(oid)                     // aid / season_id / song_id
                .addSubId(params.a())            // cid
                .build())
            .setPlayerArgs(MusicMossApiService.a().u())
            .build());
}
```

`PlayerArgs` 的构造（`MusicMossApiService.u()`）：

```java
PlayerArgs.newBuilder()
  .setQn(0x40)                                  // 64 = 请求 DASH 音质表
  .setFnver(PlayUrlFlagsManager.getFnVer())
  .setFnval(PlayUrlFlagsManager.getFnVal())
  .setSoftFnval(PlayUrlFlagsManager.getSoftFnVal())
  .setForceHost(PlayerSettingHelper.getForceHost())
  .setVoiceBalance(IjkOptionsHelper.getVolumeBalance() ? 1 : 0)
  .build();
```

### 1.3 桌面端等价实现

Web 端同一套 playurl 网关有 REST 版本，语义完全一致：

```
GET https://api.bilibili.com/x/player/wbi/playurl
    ?bvid=BVxxx&cid=123&fnval=4048&fnver=0&fourk=1&platform=pc   (+ wbi 签名)
→ data.dash.audio[] { id, baseUrl, backupUrl[], bandwidth, codecs, mimeType }
```

`fnval=4048` = DASH(16) | HDR(64) | 4K(128) | 杜比音频(256) | 杜比视觉(512) | 8K(1024) | AV1(2048)。

### 1.4 为什么必须有本地代理

音频 CDN（`*.bilivideo.cn:8082`）校验 `Referer: https://www.bilibili.com/` 和 UA，`<audio src="...">` 没法自定义请求头，直连必 403。

`services/proxy.js` 起一个 `127.0.0.1:45871` 的 HTTP 服务（端口固定，因为前端要提前拼图片代理 URL）：

- 前端拿 `localUrl`（`http://127.0.0.1:45871/audio/<bvid>_<cid>`）当 src
- 代理收到请求后补上 Referer/UA 转发到 CDN
- **透传 Range 头**，所以拖动进度条是 206 局部拉取，不是重下整个文件
- 地址 90 分钟过期，代理层检查 `expireAt`，快过期时自动重新调 playurl 换新地址，前端无感
- `backupUrl[]` 里还有 2 个备用 CDN，主地址失败自动换
- 同一个服务还兼职**图片代理**（`/img?u=<encoded>`），因为 `<img>` 同样无法带 Referer，`i0.hdslb.com` 会 403

### 1.5 wbi 签名

B 站 2023 年起 Web API 要 `w_rid` 签名：

1. `GET /x/web-interface/nav` 拿 `wbi_img.img_url` 和 `sub_url`
2. 各取文件名（去掉路径和 `.png`），得到 `img_key` / `sub_key`
3. 64 位置换表 `MIXIN_KEY_ENC_TAB` 按 `img_key+sub_key` 取值，取前 32 位当 `mixin_key`
4. 参数按 key 字典序排序、值剔除 `!'()*`、URL 编码，拼成 query，末尾加 `wts=时间戳`
5. `w_rid = md5(query + mixin_key)`

实现在 `services/bili.js` 的 `signedQuery()`，key 缓存 30 分钟。

---

## 二、登录（三套方案）

| 方式 | 原理 | 状态 |
|---|---|---|
| **扫码登录（主推）** | B 站 TV 端接口，二维码画在应用内，手机 App 扫码确认 | ✅ 8/8 验收通过 |
| 网页登录 | 弹独立窗口加载 `passport.bilibili.com/login`，登录后轮询 session 捞 Cookie | ✅ 页面完整渲染 |
| 粘贴 Cookie | 手动粘贴 `document.cookie` | ✅ 兜底 |

### 扫码登录是怎么做的

逆向 APK 的 TV 登录模块（`com.bilibili.tv` 相关），拿到两个公开常量：

```
APPKEY = 4409e2ce8ffd12b8
APPSEC = 59b43e04ad6965f34319062b478f83dd
```

签名：参数按 key 字典序 → `k=urlencode(v)` 拼 `&` → 末尾直接接 APPSEC → MD5。

```
POST https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code
  appkey=...&local_id=0&ts=<秒>&sign=<md5>
  → { code:0, data:{ url, auth_code } }

POST https://passport.bilibili.com/x/passport-tv-login/qrcode/poll
  appkey=...&local_id=0&auth_code=...&ts=<秒>&sign=<md5>
  → code 0     = 成功，data.cookie_info.cookies[] 直接给 Cookie
  → code 86039 = 未扫码
  → code 86090 = 已扫码待确认
  → code 86038 = 二维码失效
```

这套是电视端「云视听小电视」的登录通道，等同在 TV 上登录，Cookie 由官方下发，全程不碰密码。

**为什么不主推内嵌网页**：`passport.bilibili.com` 依赖大量风控脚本 + 跨域 iframe（`s1.hdslb.com/bfs/seed/jinkela/.../iframe.html`），Electron 里能跑但脆弱；而且扫码成功后页面不一定跳转，Cookie 只在 XHR 里种下，只能靠轮询 `session.cookies` 兜底。实测网页登录页能完整渲染（二维码/密码/短信/微信/微博/QQ 全部可用），作为备选保留。

**验收结果（`node scripts/verify-login.js`，静默无窗口）：**

```
PASS  1. 扫码登录：二维码生成          host=passport.bilibili.com imgLen=3986 exp=180
PASS  2. 二维码指向官方 TV 登录域      /x/passport-tv-login/h5/qrcode/auth
PASS  3. 扫码：轮询状态正常            waiting
PASS  4. 网页登录：IPC 已注册          function
PASS  5. Cookie 登录：空值安全拒绝
PASS  6. 登录态查询可用
PASS  7. 登录弹层三 Tab               扫码登录 / 网页登录 / Cookie
PASS  8. 弹层内二维码实际渲染           naturalWidth=280
```

---

## 三、从手机版抄过来的功能

| 手机版 | 桌面版实现 |
|---|---|
| `BackgroundMusicService` 前台服务 | Electron 主进程常驻 + 托盘 |
| 通知栏 12 个 action | 托盘右键菜单 + 全局媒体键 |
| `music_podcast_bottom_play_view` | 底部 88px 播放条 |
| `music_podcast_include_play_panel` | 全屏「正在播放」页 |
| `PodcastSpeedSeekBar` 6 档 | 倍速菜单 **0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 2.0**（与 APK 数组逐值一致，默认 1.0×） |
| `music_podcast_dialog_player_setting` | 播放设置弹层 |
| 「定时关闭」超级菜单 | 定时关闭弹层（15/30/45/60/90 分钟 / **播完当前曲目** / 关闭定时） |
| 播放列表 / 收藏夹 / 最近在听 | 队列抽屉 / 收藏页 / 历史页 |
| 自动连播相关视频 | 播放到 90% 预取下一首 |
| 分P 展开 | 多分P视频自动拆成队列项 |
| 字幕当歌词 | `player/v2` 字幕轨 → 歌词滚动 |

砍掉的：弹幕、投币、点赞（听视频场景用不上，保留「在浏览器打开」外链）。

### 实机截图

全屏「正在播放」页（黑胶唱片旋转 + 封面高斯模糊背景 + 进度条 + 倍速/音量/定时）：

![BiliListen 全屏正在播放页](docs/screenshot-nowplaying.png)

---

## 四、已知限制

1. **付费/大会员内容**：`playurl` 只返 64K/132K 试听片段，需要登录且开通大会员。桌面端会如实弹「没有可用的音频流」。
2. **地区限制**：港澳台/海外番剧需要对应地区 IP。
3. **登录方式**：三套（TV 扫码 / 内嵌网页 / 粘贴 Cookie）。扫码是主方案，走 B 站 TV 端官方接口。Cookie 明文存 `%APPDATA%\bili-listen-desktop\bili-listen-config.json`。
4. **字幕覆盖率**：只有 UP 主上传或 B 站 AI 生成的字幕才有歌词，大部分音乐区视频没有。
5. **音频编码**：默认 AAC（mp4a.40.2），Chromium 原生支持。杜比（EC3）和 Hi-Res（FLAC）需要大会员且部分设备解码不了，选了会静默回落到 192K。

---

## 五、拆包环境

```powershell
# 本机已有
A:\Tools\rea-tools\apktool_2.11.1.jar     # apktool
A:\Tools\rea-tools\jadx-headless-mcp-0.7.1-all.jar   # jadx（MCP 模式）
C:\Program Files\Java\jdk-21.0.12          # JDK 21
A:\Android\Sdk\build-tools\36.1.0\aapt2.exe
```

重新解包（两条路都实测过）：

```powershell
# A) 只解资源 + Manifest（快，约 40 秒）
java -jar A:\Tools\rea-tools\apktool_2.11.1.jar d -f -s -o decoded\apktool apk\bilibili-latest.apk

# B) 连 smali 一起反编译（慢，约 6 分钟，38 个 dex 全部 baksmali）
java -jar "C:\Users\27178\WorkBuddy AI\2026-10-03-07-32-11\.tools\apktool.jar" d -r -f -o decoded\smali apk\bilibili-latest.apk
#   注意 -r 是"跳过资源反编译"，不是"只解资源"；-s 才是"跳过 smali"
```

产物对照：

| 目录 | 内容 | 大小 |
|---|---|---|
| `decoded\apktool\` | `AndroidManifest.xml`、`res\`（含 201 个 `music_podcast_*` 资源）、`apktool.yml` | 425 MB |
| `decoded\smali\smali_classes2 ~ 38\` | 38 个 dex 的 smali（336,772 个文件；`music_podcast` 的 521 个在 `smali_classes16`） | 2.88 GB |

> 如果只想快速看某个类的逻辑，用 jadx 反编译成 Java 比读 smali 快得多：
> `A:\Tools\rea-tools\jadx-headless-mcp-0.7.1-all.jar`（MCP 模式）或 `jadx.bat`（CLI）。


