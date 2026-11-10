# BiliListen 设计样本（手机版对照）

## 手机版「听视频」播放页控件布局（从 APK 布局反编译提取）

`music_podcast_include_play_panel.xml` 的实际控件树：

```
panel_layout
├── 封面区（大图，圆角，带模糊背景）
├── 信息区
│   ├── 标题
│   ├── UP 主
│   └── 播放量 / 弹幕数
├── action_line（互动条）
│   ├── action_like    点赞（svga_like 动效）
│   ├── action_coin    投币（coin_progress 进度）
│   ├── action_favorite 收藏（favorite_progress）
│   ├── action_comment 评论
│   └── action_share   分享
├── seek_bar_line（进度区）
│   ├── seekbar_progress   进度条
│   ├── start_time         当前时间
│   └── duration_time      总时长
└── 控制区
    ├── panel_model       播放模式（顺序/循环/单曲/随机）
    ├── panel_model_speed 倍速
    ├── panel_previous    上一首
    ├── panel_pause       播放/暂停
    ├── panel_next        下一首
    └── play_list_menu    播放列表
```

`music_podcast_bottom_play_view.xml`（底部迷你条）：

```
progress       细进度条（贴顶，2dp）
title          标题（单行跑马灯）
author         UP 主
pause          播放/暂停按钮
play_list_menu 播放列表按钮
```

`music_podcast_dialog_player_setting.xml`（设置弹层）：

```
title                  "播放设置"
speed_setting_title    "播放速度"
speed_seekbar          PodcastSpeedSeekBar（6 档：0.75/1.0/1.25/1.5/1.75/2.0，默认 index=2）
mode_setting_title     "播放模式"
recycler_view          GridLayoutManager spanCount=2（4 个模式按钮，2×2）
close                  "关闭"
```

## 桌面端映射

| 手机版控件 | 桌面端位置 |
|---|---|
| `music_podcast_bottom_play_view` | 底部 88px 播放条 |
| `music_podcast_include_play_panel` | 全屏「正在播放」页右栏 |
| `music_podcast_dialog_player_setting` | 播放条上的「倍速」按钮弹层 |
| `action_line` 五件套 | 全屏播放页底部（点赞/投币/收藏做成跳转原视频） |
| `panel_model` | 播放条模式按钮（轮换） |
| `play_list_menu` | 播放条队列按钮（右侧抽屉） |
| `PodcastSpeedSeekBar` | 播放条倍速菜单（0.75–2.0 六档） |

## 配色参照（B 站官方设计语言）

- 主品牌粉 `#FB7299`（B 站标准粉）
- 辅助蓝 `#00AEEC`（B 站标准蓝）
- 手机版听视频用的是 **夜间模式深色底**，因为主要使用场景是睡前/通勤
- 桌面端沿用深色为主，浅色作为可选主题
