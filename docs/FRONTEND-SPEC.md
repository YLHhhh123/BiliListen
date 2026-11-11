# BiliListen 前端开发规格（交付给 glm-5.3-flash 子代理）

## 0. 你的任务

在 `app\src\` 下**从零实现**一套完整的桌面端「听视频」前端界面。
主进程（Electron）与后端服务已经写好，**不要改 `app/electron/` 下任何文件**，只写 `app/src/` 里的东西。

技术栈要求：**原生 HTML + CSS + 原生 ES Module JavaScript**。不要引入 React/Vue/构建工具，不要 npm install 新依赖。Electron 27 的 Chromium 118，支持 ES2022、CSS 嵌套不要用（118 不支持原生嵌套，用普通选择器）。

## 1. 必须交付的文件

```
app/src/
├── index.html          # 单页入口（唯一 HTML）
├── styles/
│   ├── base.css        # reset / 变量 / 字体 / 滚动条
│   ├── layout.css      # 标题栏 / 侧边栏 / 内容区 / 底部播放条
│   └── components.css  # 卡片 / 按钮 / 进度条 / 弹层 / toast / 骨架屏
├── js/
│   ├── app.js          # 入口，初始化路由与全局状态
│   ├── api.js          # 封装 window.bili，统一错误处理
│   ├── store.js        # 全局状态（发布订阅）+ localStorage 缓存
│   ├── session.js      # 播放现场快照：写盘节流 / 启动还原（见 3.15）
│   ├── player.js       # 音频播放内核（HTMLAudioElement 封装）
│   ├── router.js       # 视图切换
│   ├── views/
│   │   ├── discover.js     # 发现页（推荐/热门）
│   │   ├── ranking.js      # 排行榜（音乐区）
│   │   ├── search.js       # 搜索页
│   │   ├── favorites.js    # 收藏夹
│   │   ├── history.js      # 最近在听
│   │   └── nowplaying.js   # 全屏「正在播放」页
│   └── components/
│       ├── titlebar.js     # 自绘标题栏（最小化/最大化/关闭/搜索框）
│       ├── sidebar.js      # 侧边导航
│       ├── playbar.js      # 底部播放条
│       ├── queue.js        # 播放队列抽屉
│       ├── card.js         # 视频卡片
│       ├── toast.js        # 轻提示
│       └── modal.js        # 通用弹层（登录/定时关闭/设置）
└── assets/
    └── logo.svg
```

## 2. 主进程已经暴露的 API（挂在 `window.bili`）

所有方法都是 `async`，返回 `{ ok: true, data }` 或 `{ ok: false, error, code }`。**必须判断 `ok`**。

```js
// 内容
bili.search({ keyword, page=1, pageSize=20, order='' })
  → { items: VideoItem[], total, page, pageSize }
bili.video({ bvid })
  → { bvid, aid, title, cover, desc, duration, pubdate, owner:{mid,name,face},
      stat:{view,danmaku,reply,favorite,coin,like,share}, cid, pages:[{cid,page,part,duration}] }
bili.related({ bvid, pageSize=20 })   → { items: VideoItem[] }
bili.ranking({ rid=3, pageSize=30 })  → { items: VideoItem[] }     // rid: 3=音乐 0=全站 4=游戏 36=科技
bili.popular({ page=1, pageSize=30 }) → { items: VideoItem[], noMore }
bili.playurl({ bvid, cid, quality=30280 })
  → { url, backupUrls, expireAt, mimeType, codecs, bandwidth, duration,
      quality, qualities:[{id,bandwidth,codecs,name,desc,codec}], localUrl, key }
  // ★ 播放时必须用 localUrl（本地代理，自动带 Referer），不要用 url

// 账号
bili.login(cookieString)  → { isLogin, mid, uname, face, vip, level }
bili.loginStatus()        → 同上
bili.logout()             → { ok:true }
bili.favFolders({})       → { folders:[{id,title,mediaCount,cover}] }
bili.favList({ mediaId, page=1, pageSize=40 }) → { items:VideoItem[], hasMore }
bili.history({ page=1, pageSize=20 }) → { items:VideoItem[], cursor }

// 配置（持久化到 %APPDATA%\BiliListen\bili-listen-config.json，详见 3.15）
bili.getAllConfig()       → { volume, rate, quality, playMode, sleepTimer, showLyric, autoNext,
                              theme, minimizeToTray, windowBounds, lastRoute,
                              cookie, user, session, schema, dataDir }
                            // ★ 这个是扁平对象，不套 {ok,data}；判断方式：看 config.cookie
bili.setConfig(patch)     → { ok, data: 合并后的完整配置 }
bili.setConfigSync(patch) → 同上，同步返回（只给 beforeunload / 退出前用）
bili.dataDir()            → { ok, data: 'C:\\Users\\<你>\\AppData\\Roaming\\BiliListen' }
bili.openDataDir()        → { ok }        // 用资源管理器打开数据目录

// 窗口
bili.minimize(); bili.maximize(); bili.close(); bili.isMaximized()
bili.openExternal(url); bili.version(); bili.platform()

// 主进程 → 渲染进程
bili.onPlayerCommand(cb)      // cb(cmd): 'toggle' | 'next' | 'prev' | 'stop'
bili.reportPlayerState(state) // { playing:boolean, title:string }  用于托盘 tooltip
```

### VideoItem 结构

```js
{ bvid, aid, title, author, cover, duration /* 秒 */, play, pubdate /* ms */, type:'video',
  desc?, progress? /* 历史页：已播秒数 */ }
```

## 3. 功能需求（逐条验收）

### 3.1 窗口与布局
- 自绘标题栏（`frame:false`）：左侧 logo + 产品名「BiliListen」；中间搜索框（回车触发搜索）；右侧 最小化/最大化/关闭 三个按钮（用 SVG 图标，hover 有反馈，关闭按钮 hover 变红）。
- 标题栏 `-webkit-app-region: drag`，交互元素要 `no-drag`。
- 左侧固定侧边栏 220px：发现 / 排行榜 / 最近在听 / 我的收藏 / 设置；底部显示用户头像+昵称（未登录显示「点击登录」）。
- 主内容区可滚动，顶部有一个随路由变化的页面标题 + 副标题。
- 底部播放条 fixed，高 88px，**永远可见**（没有正在播放时显示占位提示「选择一首开始听」）。

### 3.2 视频卡片
- 封面 16:9，圆角 10px，hover 轻微上浮 + 阴影。
- 封面右下角时长胶囊（`12:34` / `1:02:03`）。
- 封面右上角悬浮播放按钮（hover 才出现）。
- 标题最多 2 行，`-webkit-line-clamp: 2`。
- 第二行：UP 主 · 播放量（`12.3万`）+ 发布时间（`3天前`）。
- 整卡点击 = 播放（不是打开详情）。
- 卡片右上角 `⋯` 菜单：加入队列 / 稍后播放 / 在浏览器打开。

### 3.3 播放内核（重点，最容易出错）
- 用 `new Audio()`，`src = localUrl`。
- `preload='auto'`，`crossOrigin` 不要设（本地代理已带 CORS）。
- 事件：`loadedmetadata` → 更新总时长；`timeupdate` → 更新进度（节流 250ms）；`ended` → 按播放模式自动下一首；`error` → 提示「播放失败，可能已过期，点击重试」。
- 切歌流程：`bili.playurl({bvid, cid})` → 拿到 localUrl → `audio.src = localUrl` → `audio.play()`。
- **不要**在切歌时复用旧 localUrl（key 是 `bvid_cid`，不同分P 不同 key）。
- 音量 0–1 渐变，静音按钮记忆上次音量。
- 倍速：`audio.playbackRate`，播放条用**下拉列表选择**（原生 select 透明覆盖在徽标上，点徽标即弹原生下拉），档位 `[0.5, 0.75, 1.0, 1.25, 1.5, 2.0]`，选完持久化；设置页的「默认倍速」滑杆与它共用 `store.rate`。
- 进度条：hover 显示时间气泡；点击/拖动 seek；拖动时暂停 timeupdate 回写避免抖动。
- 缓冲中显示 loading 态（封面转圈或播放条上的小 spinner）。
- 播放失败自动重试 1 次（重新调 playurl 拿新地址）。

### 3.4 播放模式
- `order` 顺序播放（播完不循环，到队尾停）
- `loop` 列表循环
- `single` 单曲循环
- `shuffle` 随机
- 切换按钮点击轮换，图标 + tooltip 提示当前模式。

### 3.5 队列
- 右侧抽屉（宽 360px，从右滑入）。
- 显示当前播放项高亮 + 序号。
- 支持：点击跳播、删除单条、清空、拖拽排序（用 HTML5 draggable，不用第三方库）。
- 队列为空显示空状态插画（用 CSS 画个音符）。

### 3.6 全屏「正在播放」页
- 点击底部播放条左侧封面 → 展开全屏（覆盖内容区，带 transition）。
- 布局：左侧大封面（带缓慢旋转黑胶效果，`animation: spin 20s linear infinite`，暂停时 `animation-play-state: paused`）；右侧信息区：标题、UP 主、播放量、进度条、控制按钮组（上一首/播放/下一首/模式/倍速/定时/音量）。
- 背景：封面高斯模糊 + 暗化（`filter: blur(60px) brightness(0.3)`，单独一层，`overflow:hidden`）。
- 右下角「返回」按钮 + ESC 键返回。
- 若 `autoNext` 开启，播放到 90% 时预取下一首的 playurl（静默，不报错）。

### 3.7 定时关闭（双模式，可同时启用）
- 弹层是**两个独立开关**，不是单选：
  - 「播完当前曲目后暂停」：不倒计时，等 `ended` 事件；触发时不再切下一首。
  - 「定时暂停」：下拉选 15 / 30 / 45 / 60 / 90 / 120 分钟，倒计时到点淡出暂停。
- 两个开关**可同时勾选，先到者生效**；任意一个触发后另一个自动清掉（避免残留标志打断下一次播放）。
- 「关闭定时」一次清掉两个标志。
- 倒计时显示在播放条右侧：只有数字定时是 `⏰ 23:45`；叠加播完当前是 `⏰ 23:45 ·播完`；只有播完当前是 `⏰ 播完暂停`。

### 3.8 发现页
- 顶部 Tab：推荐 / 热门（两个数据源）。
- 卡片网格：`grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))`，gap 20px。
- 无限滚动（IntersectionObserver，触底加载下一页）。
- 骨架屏：加载时显示 12 个灰色占位卡（带 shimmer 动画）。

### 3.9 排行榜
- 顶部横向 Tab：音乐 / 全站 / 游戏 / 科技 / 生活（rid 分别 3 / 0 / 4 / 36 / 160）。
- 列表形态（不是网格）：左侧大序号（前三名用金/银/铜色），中间标题+UP，右侧时长。
- 点击整行播放。

### 3.10 搜索页
- 顶部搜索框（与标题栏搜索框联动）。
- 排序切换：综合 / 最多播放 / 最新发布（`order` 分别 `''` / `click` / `pubdate`）。
- 结果网格同发现页。
- 空结果页 + 搜索历史（localStorage，最多 10 条，可清空）。

### 3.11 最近在听
- 本地记录（localStorage `bl_history`，最多 200 条：`{bvid,cid,title,author,cover,duration,lastPos,updatedAt}`）。
- 若已登录，额外一个 Tab 拉 `bili.history()`。
- 列表项显示进度条（`lastPos/duration`）。

### 3.12 我的收藏
- 未登录：显示登录引导页（大按钮「扫码/粘贴 Cookie 登录」）。
- 已登录：左侧收藏夹列表（文件夹图标+名称+数量），右侧该收藏夹内容网格。
- 登录弹层：三个页签 —— 扫码登录 / 窗口登录 / 粘贴 Cookie。粘贴 Cookie 页签是一个多行 textarea（裸 `SESSDATA` 值或整行 Cookie 都认）+「从剪贴板粘贴」+「登录」，下方可展开「怎么拿到 SESSDATA」的步骤说明（`SESSDATA` 是 HttpOnly，`document.cookie` 读不到，必须从 `Application → Cookies` 复制）；失败原因就近显示在面板里，不弹 toast 了事。

### 3.12.5 自动生成播放目录（`src/js/playlist.js`）
- 「播放目录」= 把一批视频一次性灌进播放队列并从第一首开始播（复用现有队列结构，cid 留空、播放时按需取详情，不预拉 50 个 cid）。
- 四个来源（上限 50 条）：
  - **综合热门** `bili.popular`（无需登录）
  - **音乐排行榜** `bili.ranking({rid:3})`（无需登录）
  - **我的收藏** `bili.favFolders` 取第一个夹 → `bili.favList`（需登录；folder.id 就是 media_id）
  - **相关推荐** `bili.related({bvid})`，种子视频本身放队首 —— 从任意视频卡片「⋯」菜单的「以此生成播放目录」触发。
- 入口三处：侧边栏「自动目录」（弹层选来源）、队列抽屉头部「自动目录」链接（空队列快捷入口）、卡片菜单。
- 生成中显示 loading 弹层，`store.playing` 变化（真正开始播）后自动关闭。
- 失败降级：来源拉不到内容时 toast 明确原因（如「未找到收藏夹，请先登录并收藏视频」），不写坏现有队列。

### 3.13 设置页
- 默认音质：64K / 132K / 192K / 杜比 / Hi-Res（下拉）。
- 默认倍速：滑块。
- 关闭窗口时最小化到托盘：开关。
- 主题：深色 / 浅色（CSS 变量切换，`data-theme` 属性）。
- 清空本地缓存 / 退出登录。
- 显示版本号（`bili.version()`）。

### 3.14 交互细节
- 全局快捷键：空格 播放/暂停（输入框聚焦时不触发）、`←/→` 快退/快进 5 秒、`↑/↓` 音量 ±0.05、`M` 静音、`Ctrl+←/→` 上一首/下一首。
- 拖拽视频卡片到播放条 = 加入队列并播放。
- 所有网络请求失败要有 toast 提示（`toast.error(msg)`），不要 `alert`。
- 加载态用骨架屏，不要空白。
- 图片 `loading="lazy"`，加载失败用占位图（CSS 渐变 + 音符图标）。

### 3.15 数据持久化（关掉再开，接着听）

**落盘位置**：`%APPDATA%\BiliListen\bili-listen-config.json`。路径来自 `app.getPath('userData')`，不跟 package.json 的 `name` 走（改产品名不会把用户数据搞丢）；调试和验收脚本可用环境变量 `BILI_LISTEN_DATA_DIR` 整体改道。老版本的 `%APPDATA%\bili-listen-desktop` 会在首次启动时自动迁移过来（配置文件 + Local Storage / Network 等 Chromium profile），迁完写一个 `.migrated-from` 留痕。

**存什么**

| 键 | 内容 |
|---|---|
| `volume` / `rate` / `quality` / `playMode` | 播放器偏好 |
| `theme` / `showLyric` / `autoNext` / `minimizeToTray` / `windowBounds` | 界面偏好 |
| `lastRoute` | 上次所在页面，启动时还原（`discover` / `search` / `ranking` / `history` / `fav` / `settings`） |
| `cookie` / `user` | 登录态。Cookie 只存在主进程，渲染进程拿不到 `SESSDATA` 原文 |
| `session` | 播放现场快照 `{queue, currentIndex, playing, position, updatedAt}` |
| `schema` | 数据结构版本号，将来加字段 / 改字段时用来做迁移 |

**写入策略（防丢、防写坏）**

1. 先写 `bili-listen-config.json.tmp` 再 `rename` 覆盖 —— rename 是原子的，断电或强杀不会留下半截 JSON，最坏只丢这一次改动。
2. 覆盖前把旧文件复制成 `.bak`；读取时主文件解析失败自动回退 `.bak`，`.bak` 也坏就用 `DEFAULTS`（不要让一个坏文件把应用卡在启动阶段）。
3. 普通改动 150ms 防抖异步落盘；退出登录、`before-quit`、页面 `beforeunload` 走同步写（`setConfigSync`），保证「点退出 → 立刻再打开」读到的是新数据。

**会话快照的时序**（`src/js/session.js`）

- 队列 / 曲目变化（结构变化）800ms 内落盘；播放进度 5s 一次。不要每秒写盘。
- 定时关闭的两个开关（「播完当前暂停」标志 + 数字倒计时）都是**内存态，不落盘**——重启后定时自然失效，符合「睡前定时」的使用预期。
- 队列为空且没在播时**不写**。否则「打开应用啥也没听就关掉」会用空快照把上次的队列和断点盖掉——这个坑踩过。
- 启动时 `restoreSession()` 只回填队列、`currentIndex` 和进度（记到 `pendingSeek`，等 `loadedmetadata` 再 seek），**不自动出声**；用户按下播放才从那个秒数继续。
- 「最近在听」点历史条目走条目的 `lastPos` 续播，和上面的断点是两条独立路径，互不覆盖。
- 进度的 seek 在音频还没 `src` 时也必须能调（只改 `pendingSeek`，不抛错），因为还原发生在播放之前。

**设置页要有**：一行「数据目录」，显示完整路径 + 「打开」按钮（`bili.dataDir()` / `bili.openDataDir()`），方便用户备份、清空或搬机器。

**验收**

- 播到 1:30 直接关窗 → 重开：队列、曲目、1:30 位置都在，且**没有**自动播放。
- 切到搜索页再关窗 → 重开：落在搜索页。
- 退出登录再开：`cookie` 已清空，不会「幽灵登录」。
- 删掉 `bili-listen-config.json` 只留 `.bak`：能从 `.bak` 恢复。

## 4. 设计规范

### 4.1 视觉风格
**深色为主，B 站粉为辅，走「音乐播放器」质感**，不要做成网页后台管理系统的样子。

```css
:root {
  --bg-0: #0b0d11;      /* 最底层 */
  --bg-1: #12151b;      /* 侧边栏 */
  --bg-2: #171b22;      /* 卡片 */
  --bg-3: #1f242d;      /* hover */
  --text-1: #f2f4f8;    /* 主文字 */
  --text-2: #a8b0bd;    /* 次文字 */
  --text-3: #6b7280;    /* 弱文字 */
  --brand: #fb7299;     /* B 站粉 */
  --brand-dim: #d95f80;
  --accent: #00aeec;    /* B 站蓝，用于链接/次要高亮 */
  --line: rgba(255,255,255,0.07);
  --shadow: 0 8px 28px rgba(0,0,0,0.45);
  --radius: 10px;
}
[data-theme="light"] { --bg-0:#f7f8fa; --bg-1:#fff; --bg-2:#fff; --bg-3:#f0f1f4;
  --text-1:#18191c; --text-2:#61666d; --text-3:#9499a0; --line:rgba(0,0,0,0.08);
  --shadow: 0 8px 24px rgba(0,0,0,0.08); }
```

- 字体：`"HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
- 数字（时长/时间）用 `font-variant-numeric: tabular-nums`。
- 圆角统一 10px，按钮 999px 胶囊。
- 过渡统一 `transition: all .18s cubic-bezier(.4,0,.2,1)`。
- 不要用大面积纯黑 `#000`，不要用紫色渐变（AI 味）。
- 动效克制：hover 上浮 2px、按钮按下 scale .97。

### 4.2 布局尺寸
- 标题栏高 56px
- 侧边栏宽 220px
- 播放条高 88px
- 内容区 padding 24px 28px
- 卡片最小宽 240px

## 5. 代码规范

- 全部用 ES Module：`<script type="module" src="./js/app.js"></script>`
- 每个 view 导出 `export async function mount(container, params) {}` 和 `export function unmount() {}`
- 状态管理：`store.js` 里一个极简 `createStore(initial)`，提供 `get()` / `set(patch)` / `subscribe(fn)`。
- 事件绑定用事件委托，避免给每个卡片单独绑定。
- 不要用 `innerHTML` 拼接用户数据（XSS），用 `textContent` 或写一个 `el(tag, props, children)` 工具函数。
- 所有 async 函数要 try/catch，错误走 toast。
- 注释用中文，关键逻辑写清楚「为什么」。

## 6. 验收标准

1. `cd app && npx electron .` 能直接启动，无控制台报错。
2. 发现页能加载出真实 B 站视频卡片（有封面、标题、UP 主、时长）。
3. 点任意卡片能出声（默认 192K 音质），底部播放条同步显示。
4. 拖动进度条能 seek，音量/倍速生效；倍速通过下拉列表选择，档位 0.5–2.0x。
5. 播放模式切换、队列增删排序、定时关闭可用；「播完当前暂停」和「定时暂停」能同时启用、先到者触发，触发后另一个自动清掉。
6. 全屏播放页能展开/收起，黑胶旋转动画正常。
7. 搜索能出结果并播放。
8. 排行榜能切 Tab 并播放。
9. 深色/浅色主题切换正常。
10. 窗口最小化/最大化/关闭按钮正常，关闭时若开了「最小化到托盘」则隐藏到托盘。
11. 播放中关窗再开：队列、曲目、播放进度还原，且不自动出声；上次所在页面也还原（详见 3.15）。
12. 侧边栏「自动目录」能一键生成队列并开始播放（热门/榜单无需登录）；任一视频卡片菜单「以此生成播放目录」生成相关推荐队列。

## 7. 注意

- **不要**改 `app/electron/`、`app/package.json`。
- **不要**用 `fetch` 直接请求 B 站接口（会被 Referer/CORS 拦），一律走 `window.bili.*`。
- 播放必须用返回的 `localUrl`。
- 如果某个接口报错（比如未登录的收藏夹），优雅降级，不要整页崩。
- 交付前自己在 Electron 里跑一遍，确认第 6 节 10 条全过。
