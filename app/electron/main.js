'use strict';
/**
 * 主进程：窗口 / 托盘 / 全局媒体键 / IPC 网关 / 本地音频代理
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  shell,
  nativeImage,
  dialog,
  session,
  clipboard,
  safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./services/bili');
const tvLogin = require('./services/tv-login');
const { parseCookieInput, completeCookie } = require('./services/cookie-import');
const { ConfigStore } = require('./services/config-store');
const { AudioProxy } = require('./services/proxy');
const { sealCookieField, unsealCookieField } = require('./services/sealed-cookie');

// qrcode（拉 pngjs/canvas）只在真的点「扫码登录」时才需要，启动阶段不加载，
// 冷启动能省掉一整轮依赖解析。
let _qrcode = null;
function QRCode() {
  if (!_qrcode) _qrcode = require('qrcode');
  return _qrcode;
}

const isDev = process.argv.includes('--dev');
/** 静默模式：不显示窗口、不进任务栏（自动化测试用） */
const isHidden = process.argv.includes('--hidden');
/** 音频代理固定端口，前端要拼图片代理 URL 需要提前知道 */
const PROXY_PORT = 45871;
/** 登录窗口专用分区：登录态常驻，下次登录直接复用 */
const LOGIN_PARTITION = 'persist:bili-login';
/** 落盘用的 Cookie 字段（SESSDATA 是 HttpOnly，只有分区 cookie store 能拿到） */
const LOGIN_COOKIE_KEYS = ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct', 'sid'];
let win = null;
let tray = null;
let proxy = null;
let proxyReady = Promise.resolve();
let loginWin = null;
let loginPollTimer = null;
let quitting = false;

/** 启动本地音频代理。窗口不等它，首帧先出来。 */
function startProxy() {
  proxy = new AudioProxy();
  proxy.setResolver(resolveAudio);
  proxyReady = proxy
    .start(PROXY_PORT)
    .then(() => console.log('[proxy] listening on', proxy.port))
    .catch((e) => console.error('[proxy] 启动失败，播放可能不可用：', e.message));
  return proxyReady;
}

/** 代理端口（代理还没起来时也用固定端口，前端拼 URL 不会拿到空值） */
function proxyPort() {
  return (proxy && proxy.port) || PROXY_PORT;
}

// ---------------- 数据目录 ----------------
// 目录名写死成 BiliListen，不跟着 package.json 的 name / productName 走：
//   · 以后换打包方式、改显示名，用户数据都不会「凭空消失」
//   · 早期版本（bili-listen-desktop）留下的数据自动迁移一次
// 位置：%APPDATA%\BiliListen\  （卸载时保留，重装即恢复登录与队列）
const DATA_DIR_NAME = 'BiliListen';
const LEGACY_DIR_NAMES = ['bili-listen-desktop'];
/** 迁移这几项就够：配置、登录用的 cookie 分区、Chromium 本地存储 */
const MIGRATE_ITEMS = [
  'bili-listen-config.json',
  'bili-listen-config.json.bak',
  'Local State',
  'Preferences',
  'Network',
  'Cookies',
  'Cookies-journal',
  'Local Storage',
  'Session Storage',
];

function migrateDataDir(target) {
  if (fs.existsSync(path.join(target, '.migrated'))) return;
  const appData = app.getPath('appData');
  for (const name of LEGACY_DIR_NAMES) {
    const src = path.join(appData, name);
    if (!fs.existsSync(src) || path.resolve(src) === path.resolve(target)) continue;
    let copied = 0;
    for (const item of MIGRATE_ITEMS) {
      const from = path.join(src, item);
      const to = path.join(target, item);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
        copied++;
      } catch (e) {
        console.warn('[data] 迁移跳过', item, e.message);
      }
    }
    try {
      fs.writeFileSync(
        path.join(target, '.migrated'),
        `from=${name}\nat=${new Date().toISOString()}\nitems=${copied}\n`,
        'utf8',
      );
    } catch {}
    console.log(`[data] 已从 ${name} 迁移 ${copied} 项到 ${target}`);
    break;
  }
}

(function setupDataDir() {
  // 自动化测试可以用环境变量把数据目录挪走，避免污染真实配置
  const override = process.env.BILI_LISTEN_DATA_DIR;
  const dir = override || path.join(app.getPath('appData'), DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[data] 创建数据目录失败', e);
  }
  if (!override) migrateDataDir(dir);
  app.setPath('userData', dir);
})();

// ---------------- 配置持久化 ----------------
// safeStorage（Windows 底层是 Chromium os_crypt）：AES 主密钥经 DPAPI 加密后
// 写进 <userData>/Local State 的 os_crypt.encrypted_key，密钥绑定当前系统用户，
// 换机器 / 换用户拷走配置文件也解不出 cookie。
//
// 坑：Local State 由 ImportantFileWriter **延迟提交**（实测约 10 秒）。若首次
// 加密后进程在提交前被强杀/崩溃，那次用的密钥只存在于内存、从未落盘，
// 落盘的密文就成了孤儿 —— 重启后谁也解不开，用户会「凭空掉登录」。
// 对策：密钥没真正落盘前不写密封 cookie（此时保持明文，等同旧版行为），
// 等密钥就绪再补做密封迁移。窗口照常启动，不阻塞首帧。
// isEncryptionAvailable 为 false（极少数精简系统）时永久回退明文，行为同旧版。
const LOCAL_STATE_FILE = path.join(app.getPath('userData'), 'Local State');

/** os_crypt 主密钥是否已持久化到 Local State */
function osCryptKeyPersisted() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL_STATE_FILE, 'utf8'));
    return !!(j && j.os_crypt && j.os_crypt.encrypted_key);
  } catch {
    return false;
  }
}

/** 密钥落盘后才允许写密封 cookie（纯函数式门闩，供 codec getter 调用） */
let cryptoKeyReady = osCryptKeyPersisted();

/** 后台等密钥落盘；就绪后若配置仍是明文 cookie，立刻补做密封 */
function ensureCryptoKey() {
  if (cryptoKeyReady) return;
  // 触发 os_crypt 生成主密钥并排队写盘（无副作用，探针串不落盘）
  try {
    if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString('__bili_key_probe__');
  } catch {}
  const deadline = Date.now() + 20000;
  const poll = () => {
    if (osCryptKeyPersisted()) {
      cryptoKeyReady = true;
      if (config && typeof config.cookie === 'string' && config.cookie.trim()) {
        saveConfig({});
        flushConfig();
        console.log('[secure] os_crypt 密钥已落盘，cookie 已补做密封');
      }
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 250);
    else console.warn('[secure] os_crypt 密钥迟迟未落盘，本次保持明文，下次启动会重试');
  };
  setTimeout(poll, 250);
}

let _codecCache; // undefined = 未初始化；null = 不可用；{encrypt,decrypt} = 可用
function safeStorageCodec() {
  if (_codecCache !== undefined) return _codecCache;
  try {
    _codecCache = safeStorage.isEncryptionAvailable()
      ? {
          encrypt: (t) => safeStorage.encryptString(t),
          decrypt: (b) => safeStorage.decryptString(b),
        }
      : null;
  } catch {
    _codecCache = null;
  }
  return _codecCache;
}

const configStore = new ConfigStore(
  path.join(app.getPath('userData'), 'bili-listen-config.json'),
  undefined,
  {
    get encrypt() {
      // 密钥未落盘时返回 null → sealCookieField 保持明文（等同旧版），
      // 等 ensureCryptoKey() 检测到落盘后再补做密封，避免密文成孤儿。
      if (!cryptoKeyReady) return null;
      const c = safeStorageCodec();
      return c && c.encrypt;
    },
    get decrypt() {
      const c = safeStorageCodec();
      return c && c.decrypt;
    },
  },
);
let config = configStore.get();

function loadConfig() {
  config = configStore.load();
  return config;
}
function saveConfig(patch = {}) {
  config = configStore.set(patch);
  return config;
}
/** 立刻同步落盘（退出前、会话保存时） */
function flushConfig() {
  configStore.flush();
}

// ---------------- 音频代理 ----------------
const resolveCache = new Map(); // key -> {bvid,cid}
async function resolveAudio(key) {
  const meta = resolveCache.get(key);
  if (!meta) throw new Error('未知的音频资源: ' + key);
  const r = await bili.getPlayUrl({ bvid: meta.bvid, cid: meta.cid, quality: config.quality }, { cookie: config.cookie });
  return {
    url: r.url,
    backupUrls: r.backupUrls,
    expireAt: r.expireAt,
    mimeType: r.mimeType,
  };
}

// ---------------- 窗口 ----------------
function createWindow() {
  const b = config.windowBounds || {};
  win = new BrowserWindow({
    width: b.width || 1180,
    height: b.height || 760,
    x: b.x,
    y: b.y,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0f1115',
    show: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  win.once('ready-to-show', () => {
    if (!isHidden) {
      win.show();
      if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  win.on('close', (e) => {
    if (!quitting && config.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function persistBounds() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized() || win.isMaximized()) return;
  const [x, y] = win.getPosition();
  const [width, height] = win.getSize();
  saveConfig({ windowBounds: { x, y, width, height } });
}

// ---------------- 托盘 ----------------
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) img = nativeImage.createEmpty();
  } catch {
    img = nativeImage.createEmpty();
  }
  tray = new Tray(img);
  tray.setToolTip('BiliListen · 听视频');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (win) {
          win.show();
          win.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '播放 / 暂停',
      click: () => send('player:command', 'toggle'),
    },
    { label: '上一首', click: () => send('player:command', 'prev') },
    { label: '下一首', click: () => send('player:command', 'next') },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------- IPC ----------------
function registerIpc() {
  const wrap = (fn) => async (_e, payload) => {
    try {
      const data = await fn(payload || {});
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message || String(e), code: e.code };
    }
  };

  // 搜索 / 内容
  ipcMain.handle('api:search', wrap((p) => bili.search(p, { cookie: config.cookie })));
  ipcMain.handle('api:video', wrap((p) => bili.getVideo(p, { cookie: config.cookie })));
  ipcMain.handle('api:related', wrap((p) => bili.getRelated(p, { cookie: config.cookie })));
  ipcMain.handle('api:subtitle', wrap((p) => bili.getSubtitle(p, { cookie: config.cookie })));
  ipcMain.handle('api:resolve', wrap((p) => bili.resolveInput(p, { cookie: config.cookie })));
  ipcMain.handle('api:ranking', wrap((p) => bili.getRanking(p, { cookie: config.cookie })));
  ipcMain.handle('api:popular', wrap((p) => bili.getPopular(p, { cookie: config.cookie })));
  ipcMain.handle(
    'api:playurl',
    wrap(async (p) => {
      const r = await bili.getPlayUrl(p, { cookie: config.cookie });
      const cid = p.cid || 0;
      const key = `${p.bvid}_${cid || 'default'}`;
      resolveCache.set(key, { bvid: p.bvid, cid: p.cid });
      await proxyReady;
      const localUrl = await proxy.register(key, {
        url: r.url,
        backupUrls: r.backupUrls,
        expireAt: r.expireAt,
        mimeType: r.mimeType,
      });
      return { ...r, localUrl, key };
    }),
  );

  // 账号
  // ============ 粘贴 Cookie 登录（无需手机）============
  // 接受两种粘贴：整行 Cookie（DevTools → Network → Request Headers），
  // 或只复制 SESSDATA 的 Value（DevTools → Application → Cookies）。
  // 注意 SESSDATA 是 HttpOnly，document.cookie 拿不到 —— 这个错误提示必须写清楚。
  ipcMain.handle(
    'api:login',
    wrap(async ({ cookie, raw }) => {
      const parsed = parseCookieInput(raw != null ? raw : cookie);

      if (!parsed.hasSessdata) {
        const e = new Error(
          '这串 Cookie 里没有 SESSDATA。\n' +
            'SESSDATA 是 HttpOnly，document.cookie 里永远读不到它。\n' +
            '请按面板下方「怎么拿到 SESSDATA」从 DevTools 的 Application → Cookies 复制。',
        );
        e.code = 'NO_SESSDATA';
        throw e;
      }

      const status = await bili.checkLogin({ cookie: parsed.cookie });
      if (!status.isLogin) {
        const e = new Error(
          status.message && status.message !== '账号未登录'
            ? `登录校验失败：${status.message}`
            : 'SESSDATA 无效或已过期，请重新复制一份',
        );
        e.code = status.code || 'INVALID_SESSION';
        throw e;
      }

      // 部分接口（收藏夹、历史）要 DedeUserID，用户只给了 SESSDATA 时补上
      const finalCookie = completeCookie(parsed, status);
      saveConfig({ cookie: finalCookie, user: status });
      _wbiReset();
      return status;
    }),
  );

  // 读取系统剪贴板（方便从 DevTools 复制的值一键粘进面板）
  ipcMain.handle(
    'api:readClipboard',
    wrap(async () => ({ text: String(clipboard.readText() || '') })),
  );
  // ============ TV 端扫码登录（主方案）============
  // 不用开浏览器窗口：直接向 passport 的 TV 登录接口要 auth_code，
  // 本地生成二维码画在应用里，手机 B 站 App 扫码确认即可。
  // 好处：体验和手机版/电视端一致，全程不碰密码，Cookie 由官方接口下发。
  ipcMain.handle(
    'api:qrLoginCreate',
    wrap(async () => {
      const qr = await tvLogin.createQrCode();
      const dataUrl = await QRCode().toDataURL(qr.url, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      });
      return { authCode: qr.authCode, qrDataUrl: dataUrl, url: qr.url, expiresIn: qr.expiresIn };
    }),
  );

  ipcMain.handle(
    'api:qrLoginPoll',
    wrap(async ({ authCode }) => {
      const r = await tvLogin.pollQrCode(authCode);
      if (r.status === 'success') {
        saveConfig({ cookie: r.cookie, user: null });
        _wbiReset();
        // 用拿到的 cookie 查一次用户信息。
        // 安全：原始 cookie / access_token / refresh_token 只留在主进程，不下发渲染层。
        try {
          const status = await bili.checkLogin({ cookie: r.cookie });
          if (status.isLogin) saveConfig({ user: status });
          const { cookie: _omit, accessToken: _a, refreshToken: _t, ...safe } = r;
          return { ...safe, user: status };
        } catch {
          const { cookie: _omit, accessToken: _a, refreshToken: _t, ...safe } = r;
          return safe;
        }
      }
      return r;
    }),
  );

  ipcMain.handle('api:loginStatus', wrap(async () => bili.checkLogin({ cookie: config.cookie })));

  // ============ 应用内登录窗口 ============
  // SESSDATA 是 HttpOnly：浏览器里 document.cookie 读不到，passport 也只会把它拼进
  // 自家域之间的跨域同步链接（127.0.0.1 不在白名单）。唯一可靠的取法是 Chromium 自己的
  // cookie store —— 所以登录放在独立分区的窗口里跑，主进程直接读该分区的 Cookie。
  function stopLoginPoll() {
    if (loginPollTimer) {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
  }

  async function readLoginCookie(ses) {
    const list = await ses.cookies.get({});
    const map = new Map();
    for (const c of list) {
      const d = String(c.domain || '').replace(/^\./, '');
      if (!/bilibili\.com$/.test(d)) continue;
      if (!map.has(c.name)) map.set(c.name, c.value);
    }
    if (!map.has('SESSDATA')) return '';
    return LOGIN_COOKIE_KEYS.filter((k) => map.has(k))
      .map((k) => `${k}=${map.get(k)}`)
      .join('; ');
  }

  function startLoginPoll(ses) {
    stopLoginPoll();
    let ticks = 0;
    let lastTried = '';
    loginPollTimer = setInterval(async () => {
      ticks++;
      if (ticks > 375) return stopLoginPoll(); // 5 分钟没登上就放弃，不死循环
      try {
        const cookie = await readLoginCookie(ses);
        if (!cookie || cookie === lastTried) return;
        lastTried = cookie;
        console.log('[login] 分区内发现新的登录 Cookie，校验中…');
        const status = await bili.checkLogin({ cookie });
        if (!status.isLogin) return;
        saveConfig({ cookie, user: status });
        _wbiReset();
        send('auth:loginCaptured', status);
        stopLoginPoll();
        if (loginWin && !loginWin.isDestroyed()) loginWin.close();
      } catch {
        // 单次失败忽略，下一拍继续
      }
    }, 800);
  }

  ipcMain.handle(
    'api:browserLogin',
    wrap(async () => {
      if (loginWin && !loginWin.isDestroyed()) {
        loginWin.focus();
        return { opened: true, reuse: true };
      }
      const ses = session.fromPartition(LOGIN_PARTITION);
      loginWin = new BrowserWindow({
        width: 1000,
        height: 720,
        autoHideMenuBar: true,
        title: '登录哔哩哔哩',
        webPreferences: {
          partition: LOGIN_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      loginWin.on('closed', () => {
        loginWin = null;
        stopLoginPoll();
      });
      await loginWin.loadURL('https://passport.bilibili.com/login');
      startLoginPoll(ses);
      return { opened: true };
    }),
  );

  // 手动打开 B 站网页（让用户确认登录状态 / 管理账号）
  ipcMain.handle('api:openBiliWeb', (_e, url) => {
    const target = url || 'https://www.bilibili.com';
    const sess = session.fromPartition('persist:bili-login');
    const w = new BrowserWindow({
      width: 1100,
      height: 760,
      autoHideMenuBar: true,
      title: '哔哩哔哩',
      webPreferences: { partition: 'persist:bili-login', nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    w.loadURL(target);
    return true;
  });
  ipcMain.handle('api:logout', wrap(async () => {
    saveConfig({ cookie: '', user: null });
    return { ok: true };
  }));
  ipcMain.handle('api:favFolders', wrap((p) => bili.getFavFolders({ ...p, cookie: config.cookie })));
  ipcMain.handle('api:favList', wrap((p) => bili.getFavList({ ...p, cookie: config.cookie })));
  ipcMain.handle('api:history', wrap((p) => bili.getHistory({ ...p, cookie: config.cookie })));

  // 配置
  // 安全边界：渲染层永远拿不到 cookie 字段（含加密信封）。
  // 登录态展示只需要 user（昵称/头像/等级，都是公开信息）。
  ipcMain.handle('store:getAll', () => {
    const { cookie: _omit, ...safe } = config;
    return { ...safe, dataDir: app.getPath('userData'), cookieSealed: true };
  });
  // 渲染层的 setConfig 只允许写 UI / 播放偏好；cookie / user 只能由登录 IPC（主进程）写入，
  // 防止被注入的脚本或失控的渲染代码覆写凭据。
  const RENDER_WRITABLE_KEYS = [
    'volume',
    'rate',
    'quality',
    'playMode',
    'sleepTimer',
    'showLyric',
    'autoNext',
    'theme',
    'minimizeToTray',
    'windowBounds',
    'lastRoute',
    'session',
  ];
  ipcMain.handle(
    'store:set',
    wrap(async (patch) => {
      const safePatch = {};
      if (patch && typeof patch === 'object') {
        for (const k of RENDER_WRITABLE_KEYS) {
          if (k in patch) safePatch[k] = patch[k];
        }
      }
      saveConfig(safePatch);
      // 会话类改动（队列/断点）要求「关掉再开还在」，不等防抖
      if (safePatch.session) flushConfig();
      const { cookie: _omit, ...safeReturn } = config;
      return safeReturn;
    }),
  );
  // 窗口关闭前同步落盘：invoke 是异步的，beforeunload 里等不到回包
  ipcMain.on('store:setSync', (e, patch) => {
    try {
      const safePatch = {};
      if (patch && typeof patch === 'object') {
        for (const k of RENDER_WRITABLE_KEYS) {
          if (k in patch) safePatch[k] = patch[k];
        }
      }
      saveConfig(safePatch);
      flushConfig(); // beforeunload 里等不到异步回包，无条件同步落盘
      e.returnValue = { ok: true };
    } catch (err) {
      e.returnValue = { ok: false, error: err.message };
    }
  });
  ipcMain.handle('store:dataDir', () => configStore.stat());
  ipcMain.handle('store:openDataDir', () => shell.openPath(app.getPath('userData')));

  // 窗口控制
  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    if (config.minimizeToTray) win && win.hide();
    else {
      quitting = true;
      app.quit();
    }
  });
  ipcMain.handle('window:isMaximized', () => (win ? win.isMaximized() : false));

  // 外链 / 复制
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:platform', () => process.platform);

  // 图片代理：把 B 站 CDN 封面转成带 Referer 的本地 URL
  // （<img> 无法自带 Referer，i0.hdslb.com 对无 Referer 请求会 403）
  ipcMain.handle(
    'api:img',
    wrap(async ({ url }) => {
      if (!url) return { url: '' };
      return { url: `http://127.0.0.1:${proxyPort()}/img?u=${encodeURIComponent(url)}` };
    }),
  );

  // 前端启动时拿代理基址（图片 URL 需要同步拼）
  ipcMain.handle('app:proxyBase', () => `http://127.0.0.1:${proxyPort()}`);

  // 托盘同步
  ipcMain.on('player:state', (_e, state) => {
    if (tray) {
      const label = state && state.playing ? '播放中' : '已暂停';
      tray.setToolTip(`BiliListen · ${state?.title || '听视频'} · ${label}`);
    }
  });
}

let _wbiReset = () => {};

// ---------------- 媒体键 ----------------
function registerMediaKeys() {
  const tryReg = (acc, cmd) => {
    try {
      globalShortcut.register(acc, () => send('player:command', cmd));
    } catch {}
  };
  tryReg('MediaPlayPause', 'toggle');
  tryReg('MediaNextTrack', 'next');
  tryReg('MediaPreviousTrack', 'prev');
  tryReg('MediaStop', 'stop');
  // 备用快捷键
  tryReg('CommandOrControl+Alt+Space', 'toggle');
  tryReg('CommandOrControl+Alt+Right', 'next');
  tryReg('CommandOrControl+Alt+Left', 'prev');
}

// ---------------- 生命周期 ----------------
// 任务栏分组 / 通知归属都靠这个 ID，不设的话打包版会显示成 electron.app.Electron
if (process.platform === 'win32') app.setAppUserModelId('com.bililisten.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    ensureCryptoKey(); // 后台等 os_crypt 密钥落盘；就绪后补做明文 cookie 的密封迁移
    registerIpc();
    // 先把窗口画出来，再去起代理 / 托盘：代理 init 有磁盘和 socket 开销，
    // 放在 createWindow 之前会白等 100~300ms 才见窗口。
    createWindow();
    createTray();
    registerMediaKeys();
    startProxy();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 最小化到托盘时保持进程
    if (!config.minimizeToTray) app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  // 防抖中的改动不能丢：退出前同步落盘
  flushConfig();
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  flushConfig();
  try {
    await proxy?.stop();
  } catch {}
});
