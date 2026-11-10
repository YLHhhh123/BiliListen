# APK 拆包证据链（smali 级原文）

本文是 `REVERSE-NOTES.md` 的**证据附录**：每一条结论都对应下面可复现的 smali 原文，路径均可直接打开核对。

拆包命令（本机实测）：

```powershell
# 资源 + Manifest（已做，产物在 decoded\apktool）
java -jar "C:\Users\27178\WorkBuddy AI\2026-10-03-07-32-11\.tools\apktool.jar" `
     d -r -f -o decoded\smali apk\bilibili-latest.apk
# 上面这条 -r 只跳过资源反编译，classes*.dex 会全部 baksmali 成 smali
# 产物：decoded\smali\smali_classes2 ~ smali_classes38（共 38 个 dex）
```

APK 身份：`tv.danmaku.bili` v8.91.1 / versionCode 8911100 / minSdk 23 / targetSdk 35 / 182.9 MB
`SHA-256 e6f1adee9b96ce9eb79001f27ab0688b5c1712f3c635bc9d6e2db82d1a9c30c8`

---

## 1. 「听视频」模块的完整类图（`smali_classes16`）

整个功能在 **`smali_classes16/com/bilibili/music/podcast/`** 一个包下，**521 个 smali 文件**（实测 `Get-ChildItem -Recurse -Filter *.smali | Measure`），分 8 个子包 + 12 个根级类：

| 子包 | 文件数 | 职责 |
|---|---|---|
| `view/` | 121 | 播放面板、迷你条、倍速 SeekBar、拖拽加载、底部抽屉 |
| `fragment/` | 116 | 发现 / 推荐 / 最近在听 / 播单详情 / UP 主稿件 / 收藏详情 |
| `utils/` | 96 | 收藏/三连/评论/插入队列等辅助 |
| `collection/` | 56 | 我的收藏（一级/二级文件夹、MultitypeMedia 多形态媒体） |
| `data/` | 51 | ViewModel + MusicPlayItem / MusicPlayVideo 数据模型 |
| `legacy/` | 43 | 老版「音乐」模块（降级用） |
| `moss/` | 18 | gRPC-Moss 业务接口封装（**核心**） |
| `player/` | 8 | 播放地址解析器 + 初始化模式（**核心**） |
| 根级 | 12 | 8 个 Activity + 顶部栏/卡片转场等 |

### 1.1 Activity（Manifest 声明原文）

`decoded/apktool/AndroidManifest.xml`：

```xml
<activity android:name="com.bilibili.music.podcast.MusicPodcastMainActivity"
          android:theme="@style/AppTheme.MusicPodcast"
          android:screenOrientation="portrait"
          android:configChanges="keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize"
          android:launchMode="singleTop" />
<activity android:name="com.bilibili.music.podcast.MusicPodcastPlayListActivity" ... />
<activity android:name="com.bilibili.music.podcast.legacy.MusicPodcastLegacyActivity" ... />
<activity android:name="com.bilibili.music.podcast.MusicPodcastCardTransferActivity" ... />
<activity android:name="com.bilibili.music.podcast.FavoriteCreateActivity" ... />
<activity android:name="com.bilibili.music.podcast.MusicPodcastFindAllListActivity" ... />
<activity android:name="com.bilibili.music.podcast.MusicLegacyMenuEditActivity" ... />
<activity android:name="com.bilibili.music.podcast.legacy.ContributionErrorPagerActivity" ... />
```

深链入口（同一个 Manifest）：

```xml
<data android:scheme="bilibili" android:host="music" />
<data android:scheme="bilibili" android:host="podcast" />
```

即 `bilibili://music` / `bilibili://podcast` 可直达听视频模块 —— 反过来说明这是个**独立业务模块**，不是某页面的附属 Tab。

### 1.2 后台播放服务

```xml
<service android:name="tv.danmaku.bili.ui.player.notification.BackgroundMusicService"
         android:exported="false"
         android:foregroundServiceType="mediaPlayback"
         android:label="@string/playerbaseres_global_string_253" />
```

对应 smali：`smali_classes31/tv/danmaku/bili/ui/player/notification/BackgroundMusicService.smali`

关键常量（`const-string` 原文）：

```
"player_with_background_music"     # MediaSession tag
"BackgroundPlay"                   # 日志 TAG
"music service start with null intent."
"is_liked"                         # 通知栏点赞态字段
```

`onStartCommand` / `release()` / `onBind(Intent): IBinder` 三件套说明它是标准 `Service` + `MediaSessionCompat` 组合（`E(MediaSessionCompat)` 方法负责注入 session）。

---

## 2. 播放链路：从点击到出音（全链路原文）

### 2.1 入口：`MusicPodcastResolver.requestPlayView()`

文件：`smali_classes16/com/bilibili/music/podcast/player/resolve/MusicPodcastResolver.smali`

```smali
.method private final requestPlayView(Lcom/bilibili/music/podcast/player/resolve/MusicPodcastResolverParams;)Lcom/bapis/bilibili/app/listener/v1/PlayURLResp;
    .locals 7
    .annotation system Ldalvik/annotation/Throws;
        value = { Lcom/bilibili/lib/moss/api/MossException; }
    .end annotation

    # long oid = params.getOid();
    invoke-virtual {p1}, ...MusicPodcastResolverParams;->getOid()J
    move-result-wide v0

    # long subId = params.a();      ← a() 就是 cid
    invoke-virtual {p1}, ...MusicPodcastResolverParams;->a()J
    move-result-wide v2

    invoke-static {}, ...PlayURLReq;->newBuilder()...      # PlayURLReq.Builder
    invoke-static {}, ...PlayItem;->newBuilder()...        # PlayItem.Builder
    invoke-virtual {p1}, ...getType()I                     # item_type
    invoke-virtual {v5, p1}, ...PlayItem$b;->setItemType(I)...
    invoke-virtual {p1, v0, v1}, ...PlayItem$b;->setOid(J)...
    invoke-virtual {p1, v2, v3}, ...PlayItem$b;->addSubId(J)...
    invoke-virtual {v4, p1}, ...PlayURLReq$b;->setItem(PlayItem)...

    # PlayerArgs
    sget-object v0, ...MusicMossApiService;->a:...
    invoke-virtual {v0}, ...MusicMossApiService;->u()...PlayerArgs
    invoke-virtual {p1, v0}, ...PlayURLReq$b;->setPlayerArgs(PlayerArgs)...

    # new ListenerMoss(null, 0, null, 7, null)
    new-instance v6, Lcom/bapis/bilibili/app/listener/v1/ListenerMoss;
    const/4 v4, 0x7
    invoke-direct/range {v0 .. v5}, ...ListenerMoss;-><init>(String;ILCallOptions;ILDefaultConstructorMarker;)V
```

结论：**gRPC 方法 `bilibili.app.listener.v1.Listener/PlayURL`**，请求体 `PlayURLReq{ PlayItem{ item_type, oid, sub_id[] }, PlayerArgs }`。

### 2.2 响应判定：`getPlayViewRpc()`

```smali
invoke-virtual {v2}, PlayURLResp;->getPlayable()I
if-nez v3, :cond_1                    # playable == 0 才继续
invoke-virtual {v2}, PlayURLResp;->getPlayerInfoMap()Ljava/util/Map;
invoke-virtual {p1}, MusicPodcastResolverParams;->a()J      # 用 cid 当 map key 取 PlayInfo
invoke-interface {v2, v3}, Ljava/util/Map;->get(Ljava/lang/Object;)Ljava/lang/Object;
check-cast v2, ...PlayInfo;
invoke-virtual {v3, v2, p1}, MusicPodcastResolver$a;->e(PlayInfo;Params;)MediaResource;
...
:cond_1
new-instance p1, ...ResolvePlayableException;   # playable != 0 → 抛异常，message 来自 resp.getMessage()
```

注意 `player_info` 这个 map 的 key 在手机上用的是 **`params.a()`（cid）**，不是 qn —— 说明服务端按 `sub_id` 分发多个分P的播放信息。

### 2.3 只取音频轨：`MusicPodcastResolver$a.e()`

文件：`.../player/resolve/MusicPodcastResolver$a.smali`

```smali
invoke-virtual {p1}, PlayInfo;->getInfoCase()...InfoCase;
sget-object v4, ...PlayInfo$InfoCase;->PLAY_DASH:...
if-ne v3, v4, :cond_3

invoke-virtual {p1}, PlayInfo;->getPlayDash()...PlayDASH;
invoke-virtual {v3}, PlayDASH;->getAudioList()Ljava/util/List;     # ★ 只要 audio[]
...
:goto_0
  invoke-interface {v3, v6}, Ljava/util/List;->get(I)Ljava/lang/Object;
  check-cast v7, ...DashItem;
  new-instance v8, ...DashMediaIndex;
  invoke-virtual {v7}, DashItem;->getId()I          → iput v9, v8, DashMediaIndex;->a:I     # qn
  invoke-virtual {v7}, DashItem;->getBackupUrlList() → v8->p(List)                          # backupUrl
  invoke-virtual {v7}, DashItem;->getBaseUrl()       → iput v9, v8, DashMediaIndex;->c:String # baseUrl
  invoke-virtual {v7}, DashItem;->getBandwidth()I    → iput v9, v8, DashMediaIndex;->e:I     # bandwidth
  invoke-virtual {v7}, DashItem;->getCodecid()I      → iput v9, v8, DashMediaIndex;->f:I     # codecid
  invoke-virtual {v7}, DashItem;->getMd5()          → v8->v(String)                          # md5
  invoke-virtual {v7}, DashItem;->getSize()J         → iput-wide v9, v8, DashMediaIndex;->g:J # size

# 音频列表为空 → 直接抛
:cond_2
new-instance p1, ...ResolveMediaSourceException$ResolveInvalidCodeException;
const-string p2, "MusicResolver:resolve fail, audio list is empty"
const/4 v0, -0x8
invoke-direct {p1, p2, v0}, ...
throw p1
```

**这是「听视频」＝纯音频播放的硬证据**：整个 `MediaResource` 只用 `getAudioList()` 构建，`video_list` / `play_url` 一次都没读。

### 2.3.1 更硬的证据：`PlayDASH` 这个词条**根本没有视频轨字段**

文件：`smali_classes34/com/bapis/bilibili/app/listener/v1/PlayDASH.smali`，全部 `.field` 只有三个：

```smali
.field public static final AUDIO_FIELD_NUMBER:I = 0x3
.field public static final DURATION_FIELD_NUMBER:I = 0x1
.field public static final MIN_BUFFER_TIME_FIELD_NUMBER:I = 0x2

.field private audio_:Lcom/google/protobuf/Internal$ProtobufList;
.field private duration_:I
.field private minBufferTime_:F
```

全部 public getter 也只有 `getAudio/getAudioCount/getAudioList/getAudioOrBuilder/getAudioOrBuilderList/getDuration/getMinBufferTime`。

**对比（同一 APK 里的标准播放接口 `com.bapis.bilibili.app.playurl.v1`）**：

```smali
# ResponseDash.smali —— 标准视频播放的响应，有两条轨
.field public static final VIDEO_FIELD_NUMBER:I = 0x1
.field public static final AUDIO_FIELD_NUMBER:I = 0x2

# playurl.v1.DashItem.smalie —— 标准 DASH 单元，带视频专属字段
ID=1  BASE_URL=2  BACKUP_URL=3  BANDWIDTH=4  CODECID=5  SIZE=7
FRAME_RATE=8  WIDEVINE_PSSH=9  BILIDRM_URI=10
#   ↑ 有 FRAME_RATE（帧率）、WIDEVINE_PSSH / BILIDRM_URI（DRM）—— 这两样只有视频流才需要
```

而 **`app.listener.v1.PlayDASH`（听视频专用）只有 `audio_` 一条轨**，`DashItem` 也没有 `FRAME_RATE` / DRM 字段。

**结论**：这不是"拉了视频不看"，而是**服务端返回的响应结构里根本没有视频轨** —— protobuf schema 层面就削掉了，客户端连"想拉视频"都做不到。这是「听视频省流量」最本质的实现方式。

`PlayInfo` 的字段（同样来自 proto `.field` 列表）：

```smali
QN=1  FORMAT=2  QN_TYPE=3  PLAY_URL=4  PLAY_DASH=5  FNVAL=6  FNVER=7
FORMATS=8  VIDEO_CODECID=9  LENGTH=10  CODE=11  MESSAGE=12  EXPIRE_TIME=13  VOLUME=14
```

`DashItem`（音频轨单元）的字段：

```smali
ID=1  BASE_URL=2  BACKUP_URL=3  BANDWIDTH=4  MIME_TYPE=5  CODECS=6
SEGMENT_BASE=12  CODECID=13  SIZE=15
```

注意 `DashItem` 没有 `width` / `height` / `frame_rate` 这些视频属性 —— 又一个旁证。

### 2.4 PlayerArgs 构造（`MusicMossApiService.u()`）

文件：`.../moss/MusicMossApiService.smali`

```smali
.method public final u()Lcom/bapis/bilibili/app/archive/middleware/v1/PlayerArgs;
    invoke-static {}, ...PlayerArgs;->newBuilder()...
    const-wide/16 v1, 0x40                     # qn = 64
    invoke-virtual {v0, v1, v2}, ...PlayerArgs$b;->setQn(J)
    invoke-static {}, ...PlayUrlFlagsManager;->getFnVer()I    → setFnver
    invoke-static {}, ...PlayUrlFlagsManager;->getFnVal()I    → setFnval
    invoke-static {}, ...PlayUrlFlagsManager;->getSoftFnVal()J → setSoftFnval
    invoke-static {}, ...PlayerSettingHelper;->getForceHost()I → setForceHost
    invoke-static {}, ...IjkOptionsHelper;->getVolumeBalance()Z
      if-eqz → 0 else → 1                       → setVoiceBalance
    ...build()
```

`qn = 0x40 = 64` 是「请求 DASH 音质表」的档位哨兵值（不是 64K 码率），服务端据此返回 `player_info` 里全部可选音质。

---

## 3. 倍速：`PodcastSpeedSeekBar` 的硬编码数组

文件：`.../view/PodcastSpeedSeekBar.smali`

```smali
:array_0
.array-data 4
    0x3f000000    # 0.5f
    0x3f400000    # 0.75f
    0x3f800000    # 1.0f
    0x3fa00000    # 1.25f
    0x3fc00000    # 1.5f
    0x40000000    # 2.0f
.end array-data
```

布局 `res/layout/music_podcast_dialog_player_setting.xml`：

```xml
<com.bilibili.music.podcast.view.PodcastSpeedSeekBar
    android:id="@id/speed_seekbar"
    app:spSelectDefaultIndex="2"     ← 默认选第 3 个 = 1.0×
    app:spTextSize="12.0sp"
    app:spBigCircleRadius="10.0dip" />
```

同一布局的完整控件树（含真实中文文案，从 `values/strings.xml` 解出）：

```
ConstraintLayout（背景 @drawable/music_podcast_dialog_back）
├── title              = "播放设置"      (16sp bold, 48dp 高)
├── speed_setting_title = "倍速播放"     (Text2 色, marginTop 24dp)
├── PodcastSpeedSeekBar id=speed_seekbar (fillWidth, progressDrawable=music_podcast_speed_progress)
├── mode_setting_title  = "播放模式"     (Text2 色, marginTop 32dp)
├── RecyclerView id=recycler_view        (GridLayoutManager, spanCount=2, marginTop 16dp)
└── close               = "关闭"         (16sp, 背景 @drawable/music_podcast_shape_close)
```

播放模式 4 个按钮就是那个 2×4 的 `RecyclerView`（`spanCount=2` → 2 列 2 行）。

档位 `setSelectIndex(int)` 原文（进度换算）：

```smali
if-ltz p1, :cond_0
iget-object v0, p0, PodcastSpeedSeekBar;->u:Ljava/util/List;   # 档位列表
invoke-interface {v0}, Ljava/util/List;->size()I
if-gt p1, v0, :cond_0
iput p1, p0, PodcastSpeedSeekBar;->t:I
mul-int/lit8 v0, p1, 0x64        # index * 100 → SeekBar progress
invoke-virtual {p0, v0}, Landroid/widget/SeekBar;->setProgress(I)V
```

**结论修正**：手机版是 **6 档 `0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 2.0`**，没有 1.75，但有 0.5；默认 1.0×。
（此前笔记写的「0.75–2.0 六档、默认 1.25×」是错的，已按本证据改正。）

---

## 4. 通知栏控制（桌面端托盘菜单的等价物）

散落在 `view/mini/` 下的 `a.smali` / `c.smali` / `d$f.smali`，全部 action 常量：

```
com.bilibili.player.music.notification.play
com.bilibili.player.music.notification.pause
com.bilibili.player.music.notification.play.pause     # 播放/暂停二合一按钮
com.bilibili.player.music.notification.prev
com.bilibili.player.music.notification.next
com.bilibili.player.music.notification.stop
com.bilibili.player.music.notification.fast_forward
com.bilibili.player.music.notification.rewind
com.bilibili.player.music.notification.toggle_mode
com.bilibili.player.music.notification.like
com.bilibili.player.music.notification.unlike
```

桌面端映射：`play/pause/play.pause → 播放条播放键`、`prev/next → 上一首/下一首`、`stop → 关窗最小化到托盘`、
`fast_forward/rewind → ←/→ 快进快退 5s`、`toggle_mode → 播放模式轮换`、`like/unlike → 外链打开原视频`。

---

## 5. gRPC 业务面（`ListenerMoss` 全部方法）

文件：`smali_classes34/com/bapis/bilibili/app/listener/v1/ListenerMoss.smali`

```java
// 播放
executePlayURL            // ★ 听视频取流
executePlayActionReport   // 播放行为上报（进度、完播）
executePlayHistory        // 云端播放历史（最近在听）
executePlayHistoryAdd
executePlayHistoryDel
// 内容
executePickFeed           // 推荐流（发现页）
executePickCardDetail
executeRcmdPlaylist       // 推荐播单
executePlaylist           // 播单详情
executePlaylistAdd / executePlaylistDel
executeMedialist          // 稿件列表（UP 主稿件 / 收藏夹内容）
// 收藏
executeFavFolderList / executeFavFolderCreate / executeFavFolderDelete / executeFavFolderDetail
executeFavItemAdd / executeFavItemDel / executeFavItemBatch / executeFavoredInAnyFolders
// 互动
executeTripleLike / executeThumbUp / executeCoinAdd
// 其它
executeBKArcDetails / executeEvent / executePing
```

`MusicMossApiService` 把其中 17 个包成了业务方法（`a`~`w` 混淆名），映射：

```
a → favItemDel          c → favFolderCreate      e/f/g → favFolderDetail
i → favFolderList       j → playHistory          k → pickCardDetail
l → pickFeed            m → playlist             n → rcmdPlaylist
o → medialist           p → coinAdd              q → playHistoryAdd
r → thumbUp             s → playlistDel          t → playActionReport
u → PlayerArgs 构造     v → removeAllFav         w → (收藏相关)
```

---

## 6. 收藏域模型（`collection/api`）

`MultitypeMedia`（58 KB smali，最大单文件之一）用一个类承载三种媒体形态：

```java
MultitypeMedia
├── MultitypeMedia$UGC     // 普通视频（aid + cid）
├── MultitypeMedia$OGV     // 番剧（season_id + ep_id）
└── MultitypeMedia$Rights  // 版权/权限位（is_cooperation / pay / ugc_pay / ...）
```

`PlaySet`（播单）另有 `PlaySet$OGV` / `PlaySet$Upper` / `PlaySetGroups$DefaultFolderGroup` / `PlaySetGroups$OtherFolderGroup` —— 说明「播单」既能装视频也能装番剧，还能按 UP 主分组。

**桌面端取舍**：只实现 `UGC` 形态（普通视频 + 分P），OGV 走外链打开（番剧有版权/加密，DASH 音频轨取不到）。

---

## 7. 资源清单（桌面端可直接复用视觉参考）

`res/drawable*/music_podcast_*` 共 **120 个** drawable 文件（资源总数含 layout/color 共 201 个），其中对桌面端有用的：

| 资源 | 用途 |
|---|---|
| `music_podcast_play_can_play.png` / `music_podcast_play_can_pause.png` | 播放/暂停图标（实心三角 / 双竖条） |
| `music_podcast_play_next.png` / `music_podcast_play_previous.png` | 上一首/下一首 |
| `music_podcast_mode_play_loop.png` / `mode_play_reverse.png` / `mode_single.png` / `mode_play_shuffle.png` | 四种播放模式 |
| `music_podcast_play_list_menu.png` | 播放列表（≡ 图标） |
| `music_podcast_icon_headset.png` | 耳机图标（听视频标志） |
| `music_podcast_time_remind_normal/selected.png` | 定时关闭（闹钟） |
| `music_podcast_speed_progress.xml` / `speed_thumb.xml` | 倍速 SeekBar 轨道与滑块 |

`music_podcast_include_play_panel.xml` 的控件 ID 全清单（桌面全屏播放页按这个排）：
```
panel_layout
├── action_line: like_icon/like_text/svga_like/action_like
│               coin_icon/coin_text/coin_progress/svga_coin/action_coin
│               favorite_icon/favorite_text/favorite_progress/svga_favorite/action_favorite
│               comment_icon/comment_text/action_comment
│               share_icon/share_text/action_share
├── seek_bar_line: seekbar_progress / start_time / duration_time
└── panel_model / panel_model_speed / panel_previous / panel_pause / panel_next / play_list_menu
```

`music_podcast_bottom_play_view.xml`（底部迷你条）：

```
progress (SimpleProgressView，2dp 贴顶细条)
title (14sp, singleLine)
author (12sp, singleLine)
pause (48dip 图标按钮)
play_list_menu (48dip 图标按钮)
```

---

## 8. 复现验证清单

想自己复核上述任何一条，按这个顺序：

```powershell
cd bili-listen

# 1) 看模块规模
(Get-ChildItem decoded\smali\smali_classes16\com\bilibili\music\podcast -Recurse -Filter *.smali).Count   # 521

# 2) 看播放解析器
Get-Content decoded\smali\smali_classes16\com\bilibili\music\podcast\player\resolve\MusicPodcastResolver.smali

# 3) 看倍速数组
Select-String -Path decoded\smali\smali_classes16\com\bilibili\music\podcast\view\PodcastSpeedSeekBar.smali -Pattern 'array-data' -Context 0,8

# 4) 看通知栏 action
Get-ChildItem decoded\smali -Recurse -Filter *.smali | Select-String 'com\.bilibili\.player\.music\.notification'

# 5) 看 Manifest 组件
Select-String -Path decoded\apktool\AndroidManifest.xml -Pattern 'music.podcast|BackgroundMusicService'
```
