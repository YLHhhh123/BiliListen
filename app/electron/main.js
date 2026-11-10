'use strict';
/**
 * 主进程：窗口 / 托盘 / 全局媒体键 / IPC 网关 / 本地音频代理
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, shell, nativeImage, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const bili = require('./services/bili');
const tvLogin = require('./services/tv-login');
const QRCode = require('qrcode');
const { AudioProxy } = require('./services/proxy');

const isDev = process.argv.includes('--dev');
/** 静默模式：不显示窗口、不进任务栏（自动化测试用） */
const isHidden = process.argv.includes('--hidden');
/** 音频代理固定端口，前端要拼图片代理 URL 需要提前知道 */
const PROXY_PORT = 45871;
let win = null;
let tray = null;
let proxy = null;
let quitting = false;

// ---------------- 配置持久化 ----------------
const configPath = () => path.join(app.getPath('userData'), 'bili-listen-config.json');
const defaultConfig = {
  volume: 0.8,
  rate: 1.0,
  quality: 30280,
  playMode: 'order', // order | loop | single | shuffle
  cookie: '',
  user: null,
  sleepTimer: 0,
  theme: 'dark',
  showLyric: true,
  autoNext: true,
  minimizeToTray: true,
  windowBounds: null,
};
let config = { ...defaultConfig };

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    config = { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    config = { ...defaultConfig };
  }
}
let saveTimer = null;
function saveConfig(patch = {}) {
  config = { ...config, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('[config] save failed', e);
    }
  }, 200);
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
  ipcMain.handle(
    'api:login',
    wrap(async ({ cookie }) => {
      const status = await bili.checkLogin({ cookie });
      if (status.isLogin) {
        saveConfig({ cookie, user: status });
        try {
          await bili.getPlayUrl; // noop
        } catch {}
        _wbiReset();
      }
      return status;
    }),
  );
  // ============ TV 端扫码登录（主方案）============
  // 不用开浏览器窗口：直接向 passport 的 TV 登录接口要 auth_code，
  // 本地生成二维码画在应用里，手机 B 站 App 扫码确认即可。
  // 好处：体验和手机版/电视端一致，全程不碰密码，Cookie 由官方接口下发。
  ipcMain.handle(
    'api:qrLoginCreate',
    wrap(async () => {
      const qr = await tvLogin.createQrCode();
      const dataUrl = await QRCode.toDataURL(qr.url, {
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
        // 用拿到的 cookie 查一次用户信息
        try {
          const status = await bili.checkLogin({ cookie: r.cookie });
          if (status.isLogin) saveConfig({ user: status });
          return { ...r, user: status };
        } catch {
          return r;
        }
      }
      return r;
    }),
  );

  ipcMain.handle('api:loginStatus', wrap(async () => bili.checkLogin({ cookie: config.cookie })));

  // ============ 网页版登录 ============
  // 开一个独立分区的 BrowserWindow 加载 passport.bilibili.com，
  // 用户自己扫码/输密码，登录成功后从 session 里把 Cookie 捞出来。
  // 关键点：
  //  1) 用独立 partition，避免和主窗口共用 session 造成 Cookie 污染
  //  2) 轮询 session.cookies 检查 SESSDATA，比依赖页面 URL 跳转更可靠
  //     （扫码登录成功后 passport 页面不一定会跳转，只在 XHR 里种 Cookie）
  //  3) QR 登录的轮询接口是 /x/passport-login/web/qrcode/poll，需要放行
  ipcMain.handle(
    'api:webLogin',
    wrap(async () => {
      const part = 'persist:bili-login';
      const sess = session.fromPartition(part);
      sess.setUserAgent(bili.UA);

      const loginWin = new BrowserWindow({
        width: 420,
        height: 640,
        parent: win && !isHidden ? win : undefined,
        modal: false,
        show: true,
        autoHideMenuBar: true,
        title: '登录哔哩哔哩',
        backgroundColor: '#ffffff',
        webPreferences: {
          partition: part,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      loginWin.loadURL('https://passport.bilibili.com/login');

      // 去掉菜单栏和不需要的权限
      loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

      const extractCookie = async () => {
        const cookies = await sess.cookies.get({});
        const map = {};
        for (const c of cookies) {
          if (/(^|\.)bilibili\.com$/.test(c.domain) || c.domain.includes('bilibili')) {
            map[c.name] = c.value;
          }
        }
        if (!map.SESSDATA) return null;
        return Object.entries(map)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      };

      return await new Promise((resolve) => {
        let done = false;
        let pollTimer = null;

        const finish = async (ok, payload) => {
          if (done) return;
          done = true;
          clearInterval(pollTimer);
          clearTimeout(timeoutTimer);
          try {
            if (!loginWin.isDestroyed()) loginWin.close();
          } catch {}
          resolve(ok ? payload : { cancelled: true, reason: payload });
        };

        // 每 800ms 查一次 Cookie
        pollTimer = setInterval(async () => {
          if (loginWin.isDestroyed()) {
            finish(false, '窗口已关闭');
            return;
          }
          try {
            const cookie = await extractCookie();
            if (cookie) {
              const status = await bili.checkLogin({ cookie });
              if (status.isLogin) {
                saveConfig({ cookie, user: status });
                _wbiReset();
                finish(true, { ...status, cookieLen: cookie.length });
              }
            }
          } catch (e) {
            // 静默，等下一轮
          }
        }, 800);

        // 5 分钟超时
        const timeoutTimer = setTimeout(() => finish(false, '登录超时（5 分钟）'), 5 * 60 * 1000);

        loginWin.on('closed', () => finish(false, '用户关闭了登录窗口'));

        // 页面跳转时也检查一次（有些登录路径会直接跳到 www.bilibili.com）
        loginWin.webContents.on('did-navigate', async (_e, url) => {
          if (!/bilibili\.com/.test(url)) return;
          try {
            const cookie = await extractCookie();
            if (cookie) {
              const status = await bili.checkLogin({ cookie });
              if (status.isLogin) {
                saveConfig({ cookie, user: status });
                _wbiReset();
                finish(true, { ...status, cookieLen: cookie.length });
              }
            }
          } catch {}
        });
      });
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
  ipcMain.handle('store:getAll', () => ({ ...config }));
  ipcMain.handle(
    'store:set',
    wrap(async (patch) => {
      saveConfig(patch);
      return config;
    }),
  );

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
      return { url: `http://127.0.0.1:${proxy.port}/img?u=${encodeURIComponent(url)}` };
    }),
  );

  // 前端启动时拿代理基址（图片 URL 需要同步拼）
  ipcMain.handle('app:proxyBase', () => `http://127.0.0.1:${proxy.port}`);

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

  app.whenReady().then(async () => {
    loadConfig();
    proxy = new AudioProxy();
    proxy.setResolver(resolveAudio);
    await proxy.start(PROXY_PORT);
    console.log('[proxy] listening on', proxy.port);

    registerIpc();
    createWindow();
    createTray();
    registerMediaKeys();

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
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  try {
    await proxy?.stop();
  } catch {}
});
