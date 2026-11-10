// ===== app.js：应用入口 =====
// 初始化顺序：配置 → 播放内核 → 布局组件 → 路由 → 快捷键 → 主进程命令
// 视图按需注册：缺文件的 view 跳过，不影响启动。

import { el, svg } from './utils.js';
import { bili } from './api.js';
import { store, playHistory } from './store.js';
import {
  initPlayer, togglePlay, seekBy, setVolume, toggleMute,
  nextTrack, prevTrack, addToQueue, playVideo, getAudio,
} from './player.js';
import { register, navigate } from './router.js';
import { mountTitlebar } from './components/titlebar.js';
import { mountSidebar } from './components/sidebar.js';
import { mountPlaybar } from './components/playbar.js';
import { mountQueue } from './components/queue.js';
import { toast } from './components/toast.js';

const ICONS = {
  moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2V1zm0 19h2v3h-2v-3zM3.5 4.9L4.9 3.5l2.1 2.1-1.4 1.4-2.1-2.1zm13.5 13.5l1.4-1.4 2.1 2.1-1.4 1.4-2.1-2.1zM1 11h3v2H1v-2zm19 0h3v2h-3v-2zM3.5 19.1l2.1-2.1 1.4 1.4-2.1 2.1-1.4-1.4zM17 5.6l2.1-2.1 1.4 1.4-2.1 2.1L17 5.6z',
};

/** 应用主题到根节点 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 切换主题并持久化 */
function toggleTheme() {
  const next = store.get().theme === 'light' ? 'dark' : 'light';
  store.set({ theme: next });
  applyTheme(next);
  bili.setConfig({ theme: next }).catch(() => {});
}

// ---------- 视图注册（缺文件跳过） ----------
const VIEW_DEFS = [
  ['discover', './views/discover.js'],
  ['ranking', './views/ranking.js'],
  ['search', './views/search.js'],
  ['favorites', './views/favorites.js'],
  ['history', './views/history.js'],
  ['nowplaying-overlay', null], // 占位：nowplaying 由 mountNowPlaying 挂载，不走路由
];

async function registerViews() {
  for (const [name, path] of VIEW_DEFS) {
    if (!path) continue;
    try {
      const mod = await import(path);
      if (mod && typeof mod.mount === 'function') register(name, mod);
    } catch (e) {
      console.warn(`[app] 视图 ${name} 加载失败，已跳过：`, e.message);
    }
  }
  // 内联设置页（侧边栏有入口）
  register('settings', { mount: mountSettings, unmount() {} });
}

// ---------- 启动 ----------
async function boot() {
  // 1. 拉配置（持久化在 userData），同步进 store
  try {
    const res = await bili.getAllConfig();
    if (res.ok && res.data) {
      const c = res.data;
      store.set({
        config: c,
        user: c.user || null,
        volume: c.volume ?? 0.8,
        rate: c.rate ?? 1.0,
        playMode: c.playMode ?? 'order',
        theme: c.theme ?? 'dark',
      });
    }
  } catch (e) {
    console.warn('[app] 读取配置失败，使用默认值', e);
  }
  applyTheme(store.get().theme);

  // 2. 播放内核（config 就位后初始化，volume/rate 才是对的）
  await initPlayer();
  // player.js 的 new Audio() 不在 DOM 里，document.querySelector('audio') 查不到
  // （CDP 验收和部分浏览器扩展依赖它在 document 中），挂进 body
  document.body.appendChild(getAudio());

  // 3. 布局组件
  mountTitlebar();
  mountSidebar();
  mountPlaybar();
  mountQueue();
  // 调试桥（CDP 自动化用；正式运行无影响）
  try {
    const dbg = await import('./debug-bridge.js');
    dbg.installDebugBridge();
  } catch (e) {
    console.warn('[app] debug bridge 未加载', e.message);
  }
  // 全屏播放页：文件存在才挂
  try {
    const np = await import('./views/nowplaying.js');
    np.mountNowPlaying();
  } catch (e) {
    console.warn('[app] nowplaying 未就绪，已跳过：', e.message);
  }

  // 标题栏追加全局主题切换按钮（verify 用 [title*="主题"] 找它）
  const actions = document.querySelector('.titlebar-actions');
  if (actions) {
    const themeBtn = el('div', {
      class: 'win-btn theme-toggle', title: '切换主题', onclick: toggleTheme,
    }, [svg(store.get().theme === 'light' ? ICONS.moon : ICONS.sun, { size: 14 })]);
    actions.insertBefore(themeBtn, actions.firstChild);
    store.subscribe((s) => {
      themeBtn.innerHTML = '';
      themeBtn.appendChild(svg(s.theme === 'light' ? ICONS.moon : ICONS.sun, { size: 14 }));
    });
  }

  // 4. 注册视图并进入首页
  await registerViews();
  const ROUTES = ['discover', 'ranking', 'search', 'favorites', 'history', 'settings'];
  const initial = (location.hash || '').replace(/^#\/?/, '') || 'discover';
  navigate(ROUTES.includes(initial) ? initial : 'discover');

  // 5. 全局快捷键（输入框聚焦时跳过）
  window.addEventListener('keydown', onKeydown);

  // 6. 主进程托盘/媒体键命令
  bili.onPlayerCommand((cmd) => {
    if (cmd === 'toggle') togglePlay();
    else if (cmd === 'next') nextTrack();
    else if (cmd === 'prev') prevTrack();
    else if (cmd === 'stop') {
      const a = document.querySelector('audio');
      if (a) a.pause();
    }
  });

  // 7. 状态上报（托盘 tooltip 用）
  store.subscribe((s) => {
    bili.reportPlayerState({ playing: s.isPlaying, title: s.playing?.title || '' });
  });

  // 8. 卡片拖到播放条 = 加入队列并播放
  const playbarEl = document.getElementById('playbar');
  if (playbarEl) {
    playbarEl.addEventListener('dragover', (e) => e.preventDefault());
    playbarEl.addEventListener('drop', (e) => {
      e.preventDefault();
      try {
        const item = JSON.parse(e.dataTransfer.getData('application/json'));
        if (item && item.bvid) {
          addToQueue(item);
          playVideo(item);
          toast.info('已加入队列并播放');
        }
      } catch {}
    });
  }

  // 9. 播放进度节流写回本地历史（5 秒一次，避免高频写 localStorage）
  let lastHistoryWrite = 0;
  store.subscribe((s) => {
    if (!s.playing || !s.currentTime) return;
    const now = Date.now();
    if (now - lastHistoryWrite < 5000) return;
    lastHistoryWrite = now;
    playHistory.upsert({
      bvid: s.playing.bvid, cid: s.playing.cid,
      title: s.playing.title, author: s.playing.author,
      cover: s.playing.cover, duration: s.duration || s.playing.duration,
      lastPos: Math.floor(s.currentTime),
    });
  });
}

// ---------- 快捷键 ----------
function onKeydown(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  const s = store.get();
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    prevTrack();
  } else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    nextTrack();
  } else if (e.key === 'ArrowLeft') {
    seekBy(-5);
  } else if (e.key === 'ArrowRight') {
    seekBy(5);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setVolume(s.volume + 0.05);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setVolume(s.volume - 0.05);
  } else if (e.key === 'm' || e.key === 'M') {
    toggleMute();
  }
}

// ---------- 内联设置页 ----------
function mountSettings(container) {
  store.set({ currentRoute: 'settings' });
  const verEl = el('span', { style: { color: 'var(--text-3)' } }, '…');
  bili.version().then((v) => { verEl.textContent = v || 'unknown'; }).catch(() => {});

  const themeBtn = el('button', {
    class: 'btn', onclick: toggleTheme,
  }, store.get().theme === 'dark' ? '切到浅色' : '切到深色');

  const clearBtn = el('button', {
    class: 'btn danger',
    onclick: () => {
      try { localStorage.clear(); toast.success('本地缓存已清空'); }
      catch { toast.error('清空失败'); }
    },
  }, '清空本地缓存');

  const logoutBtn = el('button', {
    class: 'btn danger',
    onclick: async () => {
      const res = await bili.logout();
      if (res.ok) { store.set({ user: null }); toast.success('已退出登录'); }
      else toast.error(res.error || '退出失败');
    },
  }, '退出登录');

  // 默认音质：持久化 config.quality
  const QUALITY_OPTIONS = [
    ['64K', 30216], ['132K', 30232], ['192K', 30280], ['杜比全景声', 30250], ['Hi-Res 无损', 30251],
  ];
  const qualitySel = el('select', {
    class: 'btn',
    style: { width: '160px' },
  }, QUALITY_OPTIONS.map(([label, id]) => el('option', { value: id }, label)));
  qualitySel.value = String(store.get().config?.quality ?? 30280);
  if (!qualitySel.value || qualitySel.selectedIndex < 0) qualitySel.value = '30280';
  qualitySel.addEventListener('change', () => {
    const quality = Number(qualitySel.value);
    bili.setConfig({ quality }).catch(() => {});
    const cfg = store.get().config || {};
    store.set({ config: { ...cfg, quality } });
    toast.success('默认音质已更新');
  });

  // 默认倍速：滑杆 0.75–2×，实时写 store 顶层 rate（playbar 认这个字段）
  const rateVal = el('span', { style: { color: 'var(--text-2, #ccc)', minWidth: '48px', textAlign: 'right' } },
    (store.get().rate ?? 1) + '×');
  const rateRange = el('input', { type: 'range', min: '0.75', max: '2', step: '0.25' });
  rateRange.value = String(store.get().rate ?? 1);
  rateRange.addEventListener('input', () => {
    const rate = Number(rateRange.value);
    rateVal.textContent = rate + '×';
    bili.setConfig({ rate }).catch(() => {});
    store.set({ rate });
  });

  // 关窗口最小化到托盘：开关，持久化 config.minimizeToTray
  const trayChk = el('input', { type: 'checkbox' });
  trayChk.checked = store.get().config?.minimizeToTray ?? true;
  trayChk.addEventListener('change', () => {
    const minimizeToTray = Boolean(trayChk.checked);
    bili.setConfig({ minimizeToTray }).catch(() => {});
    const cfg = store.get().config || {};
    store.set({ config: { ...cfg, minimizeToTray } });
  });
  const trayLabel = el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
    [trayChk, '开启']);

  const row = (label, desc, ctrl) => el('div', { class: 'setting-row' }, [
    el('div', {}, [
      el('div', { class: 'setting-label' }, label),
      el('div', { class: 'setting-desc' }, desc),
    ]),
    ctrl,
  ]);

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, '设置'),
      el('div', { class: 'page-subtitle' }, '外观、缓存与账号'),
    ]),
    el('div', { style: { maxWidth: 640 } }, [
      row('主题', '深色 / 浅色', themeBtn),
      row('本地缓存', '清空搜索历史与播放记录', clearBtn),
      row('账号', '退出当前 B 站账号', logoutBtn),
      row('版本', 'BiliListen', verEl),
      row('默认音质', '新歌单与首次播放使用的音质档位', qualitySel),
      el('div', { class: 'setting-row', style: { gap: '12px' } }, [
        el('div', {}, [
          el('div', { class: 'setting-label' }, '默认倍速'),
          el('div', { class: 'setting-desc' }, '全局播放速度，范围 0.75–2×'),
        ]),
        rateRange,
        rateVal,
      ]),
      row('最小化到托盘', '关闭窗口时不退出，最小化到系统托盘', trayLabel),
    ]),
  );
}

boot().catch((e) => {
  console.error('[app] 启动失败', e);
  toast.error('应用启动失败：' + (e.message || e));
});
