// ===== views/nowplaying.js：全屏「正在播放」页 =====
// 黑胶旋转 + 歌词滚动 + 完整控制。由 app.js 调 mountNowPlaying() 挂载到 #nowplaying-root。

import { el, svg, fmtDuration, fmtPlay, findLyricLine } from '../utils.js';
import { store } from '../store.js';
import { bili } from '../api.js';
import {
  togglePlay, nextTrack, prevTrack, seek, setVolume, setRate, cycleMode,
  startSleepTimer, stopSleepTimer, pauseAfterCurrentTrack, cancelPauseAfterCurrent,
  RATES, getAudio,
} from '../player.js';
import { toast } from '../components/toast.js';

const ICONS = {
  close: 'M18.3 5.71L12 12.01l-6.3-6.3-1.42 1.42L10.59 13.4l-6.3 6.3 1.42 1.42 6.3-6.3 6.3 6.3 1.41-1.42-6.3-6.29 6.3-6.3z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  modeOrder: 'M3 6h13v2H3V6zm0 5h13v2H3v-2zm0 5h13v2H3v-2zm17-9v8h-3v2h5V7h-2z',
  modeLoop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  modeSingle: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-5-9v10h-2v-8l-2 1V9l3-1h1z',
  modeShuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  sleep: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-13h2v6h-4v-2h2V7z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z',
};

const MODE_META = {
  order: { icon: ICONS.modeOrder, label: '顺序播放' },
  loop: { icon: ICONS.modeLoop, label: '列表循环' },
  single: { icon: ICONS.modeSingle, label: '单曲循环' },
  shuffle: { icon: ICONS.modeShuffle, label: '随机播放' },
};

let overlay = null;
let ui = {};
let unsub = null;
let lyricLines = [];
let lyricIdx = -1;
let escHandler = null;

/** 挂载全屏层（只挂一次，之后靠 open/close 控制显隐） */
export function mountNowPlaying() {
  const host = document.getElementById('nowplaying-root');
  if (!host) return;

  overlay = el('div', { class: 'np-overlay' });
  host.appendChild(overlay);

  // 背景层（封面高斯模糊）
  const bg = el('div', { class: 'np-bg np-bg-fallback' });

  // 返回按钮
  const back = el('div', { class: 'np-back', title: '返回（ESC）', onclick: closeNowPlaying }, [
    svg(ICONS.close, { size: 20 }),
  ]);

  // 左：黑胶封面
  const disc = el('div', { class: 'np-disc' });
  const coverSide = el('div', { class: 'np-cover-side' }, [disc]);

  // 右：信息 + 控制
  const title = el('div', { class: 'np-title', text: '未在播放' });
  const author = el('div', { class: 'np-author', text: '' });
  const stats = el('div', { class: 'np-stats' });

  // 歌词区
  const lyricInner = el('div', { class: 'np-lyric-inner' });
  const lyric = el('div', { class: 'np-lyric' }, [lyricInner]);

  // 进度
  const curTime = el('span', { text: '00:00' });
  const totTime = el('span', { text: '00:00' });
  const fill = el('div', { class: 'progress-fill', style: { width: '0%' } });
  const thumb = el('div', { class: 'progress-thumb', style: { left: '0%' } });
  const track = el('div', { class: 'progress-track' }, [fill, thumb]);
  const progress = el('div', { class: 'np-progress' }, [curTime, track, totTime]);

  // 拖动 seek
  bindSeek(track);

  // 控制按钮
  const btnPrev = iconBtn(ICONS.prev, '上一首', () => prevTrack());
  const btnPlay = iconBtn(ICONS.pause, '播放/暂停', () => togglePlay(), 'play');
  const btnNext = iconBtn(ICONS.next, '下一首', () => nextTrack());
  const btnMode = iconBtn(ICONS.modeOrder, '顺序播放', () => {
    cycleMode();
    syncMode();
  });
  const controls = el('div', { class: 'np-controls' }, [btnPrev, btnPlay, btnNext, btnMode]);

  // 次要控制：倍速 / 音量 / 定时 / 互动
  const rateBtn = el('button', { class: 'btn ghost', text: '1.0×', onclick: showRateMenu });
  const volBtn = iconBtn(ICONS.volume, '静音', () => {
    const s = store.get();
    setVolume(s.volume > 0 ? 0 : 0.8);
  });
  const sleepBtn = el('button', { class: 'btn ghost', text: '定时关闭', onclick: showSleepMenu });
  const actionBtn = el('button', { class: 'btn ghost', id: 'np-action-btn', text: '⚡ 互动', onclick: showActionMenu });
  const secondary = el('div', { class: 'np-secondary' }, [rateBtn, volBtn, sleepBtn, actionBtn]);

  const infoSide = el('div', { class: 'np-info-side' }, [title, author, stats, lyric, progress, controls, secondary]);
  const content = el('div', { class: 'np-content' }, [coverSide, infoSide]);
  overlay.append(bg, back, content);

  ui = { bg, disc, title, author, stats, lyric, lyricInner, fill, thumb, curTime, totTime, btnPlay, btnMode, rateBtn, sleepBtn, volBtn, secondary };

  // 订阅 store
  unsub = store.subscribe(onStore);

  // ESC 关闭
  escHandler = (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeNowPlaying();
  };
  window.addEventListener('keydown', escHandler);

  onStore(store.get());
}

export function unmountNowPlaying() {
  if (unsub) { unsub(); unsub = null; }
  if (escHandler) { window.removeEventListener('keydown', escHandler); escHandler = null; }
  if (overlay) { overlay.remove(); overlay = null; }
  ui = {};
  lyricLines = [];
  lyricIdx = -1;
}

export function openNowPlaying() {
  if (!overlay) mountNowPlaying();
  if (!overlay) return;
  overlay.classList.add('open');
  store.set({ nowPlayingOpen: true });
}

export function closeNowPlaying() {
  if (!overlay) return;
  overlay.classList.remove('open');
  store.set({ nowPlayingOpen: false });
  if (escHandler) { /* keep listener */ }
}

/** 让 store 变成唯一真源：外部改 nowPlayingOpen 也能联动 */
export function bindNowPlayingStore() {
  store.subscribe((s) => {
    if (!overlay) return;
    const want = !!s.nowPlayingOpen;
    const isOpen = overlay.classList.contains('open');
    if (want !== isOpen) overlay.classList.toggle('open', want);
  });
}

export function toggleNowPlaying() {
  if (overlay?.classList.contains('open')) closeNowPlaying();
  else openNowPlaying();
}

// ---------- 渲染 ----------
function iconBtn(path, title, onclick, extraClass = '') {
  return el('div', {
    class: 'ctrl-btn ' + extraClass,
    title,
    onclick,
  }, [svg(path, { size: 22 })]);
}

function onStore(s) {
  if (!overlay || !ui.title) return;

  // 播放条点封面走 store.nowPlayingOpen，这里同步显示状态
  const wantOpen = !!s.nowPlayingOpen;
  const isOpen = overlay.classList.contains('open');
  if (wantOpen && !isOpen) overlay.classList.add('open');
  else if (!wantOpen && isOpen) overlay.classList.remove('open');

  const p = s.playing;

  if (!p) {
    ui.title.textContent = '未在播放';
    ui.author.textContent = '';
    return;
  }

  if (ui.title.textContent !== p.title) ui.title.textContent = p.title || '';
  ui.author.textContent = p.author ? `UP 主：${p.author}` : '';

  // 背景 + 黑胶
  if (p.cover && ui.bg.dataset.cover !== p.cover) {
    ui.bg.dataset.cover = p.cover;
    // 走本地图片代理（hdslb 校验 Referer）
    bili.img(p.cover).then((res) => {
      const u = res && res.ok && res.data ? res.data.url : p.cover;
      ui.bg.style.backgroundImage = 'url("' + u + '")';
      ui.bg.classList.remove('np-bg-fallback');
      ui.disc.style.backgroundImage = 'url("' + u + '")';
    }).catch(() => {
      ui.bg.style.backgroundImage = 'url("' + p.cover + '")';
      ui.disc.style.backgroundImage = 'url("' + p.cover + '")';
    });
  }

  // 播/暂停图标
  const wantPause = s.isPlaying ? ICONS.pause : ICONS.play;
  if (ui.btnPlay.dataset.icon !== wantPause) {
    ui.btnPlay.dataset.icon = wantPause;
    ui.btnPlay.innerHTML = '';
    ui.btnPlay.appendChild(svg(wantPause, { size: 28 }));
  }

  // 黑胶旋转
  ui.disc.classList.toggle('playing', !!s.isPlaying);

  // 进度
  const dur = s.duration || p.duration || 0;
  const cur = s.currentTime || 0;
  const ratio = dur > 0 ? Math.min(1, cur / dur) : 0;
  ui.fill.style.width = (ratio * 100).toFixed(2) + '%';
  ui.thumb.style.left = (ratio * 100).toFixed(2) + '%';
  ui.curTime.textContent = fmtDuration(cur);
  ui.totTime.textContent = fmtDuration(dur);

  // 倍速
  ui.rateBtn.textContent = (s.rate || 1).toFixed(2).replace(/0$/, '') + '×';

  // 定时
  if (s.sleepRemaining > 0) {
    const m = Math.floor(s.sleepRemaining / 60);
    const sec = s.sleepRemaining % 60;
    ui.sleepBtn.textContent = `定时 ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    ui.sleepBtn.classList.add('primary');
  } else {
    ui.sleepBtn.textContent = '定时关闭';
    ui.sleepBtn.classList.remove('primary');
  }

  // 歌词
  syncLyrics(s);
}

function syncMode() {
  if (!ui.btnMode) return;
  const mode = store.get().playMode || 'order';
  const meta = MODE_META[mode] || MODE_META.order;
  ui.btnMode.innerHTML = '';
  ui.btnMode.appendChild(svg(meta.icon, { size: 22 }));
  ui.btnMode.title = meta.label;
}

function syncLyrics(s) {
  const lines = s.lyrics || [];
  const status = s.lyricsStatus || 'idle';
  const key = status + '|' + (s.lyricsMessage || '') + '|' + lines.length;
  if (key !== lyricLines._key) {
    lyricLines = lines;
    lyricLines._key = key;
    lyricIdx = -1;
    ui.lyricInner.innerHTML = '';
    if (!lines.length) {
      let text = '暂无歌词';
      if (status === 'error') text = s.lyricsMessage || '字幕获取失败，请稍后再试';
      else if (status === 'empty') text = '该视频暂无字幕';
      else if (status === 'idle') text = '加载字幕中…';
      ui.lyricInner.appendChild(el('div', { class: 'lyric-empty', text }));
      return;
    }
    lines.forEach((ln) => {
      ui.lyricInner.appendChild(el('div', { class: 'lyric-line', text: ln.content || '' }));
    });
  }

  if (!lyricLines.length) return;

  const idx = findLyricLine(lyricLines, s.currentTime || 0);
  if (idx === lyricIdx) return;
  lyricIdx = idx;

  const nodes = ui.lyricInner.children;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].classList.toggle('active', i === idx);
  }
  if (idx >= 0 && nodes[idx]) {
    const box = ui.lyric;
    const center = box.clientHeight / 2;
    const offset = nodes[idx].offsetTop + nodes[idx].offsetHeight / 2 - center;
    ui.lyricInner.style.transform = `translateY(${-offset}px)`;
  }
}

function bindSeek(track) {
  let dragging = false;

  const ratioFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  track.addEventListener('mousedown', (e) => {
    dragging = true;
    seek(ratioFromEvent(e));
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    seek(ratioFromEvent(e));
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

// ---------- 弹层 ----------
// ---------- 视频互动：二级菜单 ----------
// 入口按钮 → 一级菜单（投币 / 收藏 / 关注）→ 二级菜单（1币/2币、收藏夹列表、关注/取关）。
// 所有写操作走主进程 IPC；cookie/csrf 不下发渲染层。
const actionState = { following: false, lastMid: 0, menu: null, detailCache: new Map() };

function closeActionMenu() {
  if (actionState.menu) { actionState.menu.remove(); actionState.menu = null; }
}

function currentVideo() {
  const p = store.get().playing;
  if (!p || !p.bvid) return null;
  const cached = actionState.detailCache.get(p.bvid) || {};
  return {
    bvid: p.bvid,
    cid: p.cid || cached.cid,
    aid: p.aid || cached.aid,
    mid: p.mid || (p.owner && p.owner.mid) || cached.mid || 0,
    author: p.author || cached.author || '',
  };
}

/** 打开菜单时按需补 aid / mid（列表项里通常没有，写接口必须要） */
function ensureVideoDetail(v) {
  if (v.aid && v.mid) return;
  if (actionState.detailCache.has('_pending_' + v.bvid)) return;
  actionState.detailCache.set('_pending_' + v.bvid, true);
  bili.video({ bvid: v.bvid }).then((res) => {
    if (res.ok && res.data) {
      actionState.detailCache.set(v.bvid, {
        aid: res.data.aid,
        cid: res.data.cid,
        mid: res.data.owner?.mid || 0,
        author: res.data.owner?.name || '',
      });
    }
    actionState.detailCache.delete('_pending_' + v.bvid);
  }).catch(() => {
    actionState.detailCache.delete('_pending_' + v.bvid);
  });
}

/** 一级菜单：三项操作入口 */
function showActionMenu() {
  const host = ui.secondary;
  if (!host) return;
  if (actionState.menu) { closeActionMenu(); return; }
  const v = currentVideo();
  const body = el('div', { class: 'action-menu' });
  actionState.menu = body;

  const head = el('div', { class: 'action-menu-head', text: '视频互动' });
  body.appendChild(head);

  if (!v) {
    body.appendChild(el('div', { class: 'action-menu-tip', text: '请先播放一个视频' }));
  } else {
    ensureVideoDetail(v);
    const item = (label, desc, onEnter) => el('div', {
      class: 'action-item',
      onclick: (e) => { e.stopPropagation(); onEnter(); },
    }, [
      el('div', { class: 'action-item-main' }, [
        el('div', { class: 'action-item-label', text: label }),
        el('div', { class: 'action-item-desc', text: desc }),
      ]),
      el('div', { class: 'action-item-arrow', text: '›' }),
    ]);
    body.appendChild(item('投币', '可选 1 / 2 币', () => renderCoinSub(body, v.bvid)));
    body.appendChild(item('收藏', '支持选择收藏夹', () => renderFavSub(body, v.bvid)));
    body.appendChild(item('关注作者', v.author || '关注 / 取关', () => renderFollowSub(body, v.bvid)));
  }

  host.appendChild(body);
  setTimeout(() => {
    const off = (ev) => {
      // 菜单内部点击（含二级别视图重绘后）一律不关；只有点到菜单外才关。
      if (!ev.target.closest || !ev.target.closest('.action-menu')) {
        closeActionMenu();
        document.removeEventListener('click', off);
        document.removeEventListener('keydown', esc);
      }
    };
    const esc = (ev) => {
      if (ev.key === 'Escape') {
        closeActionMenu();
        document.removeEventListener('click', off);
        document.removeEventListener('keydown', esc);
      }
    };
    document.addEventListener('click', off);
    document.addEventListener('keydown', esc);
  }, 0);
}

/** 通用：把菜单主体切到二级视图，带返回按钮 */
function enterSub(body, title, render) {
  body.innerHTML = '';
  const back = el('div', { class: 'action-sub-back', text: '‹ 返回', onclick: () => {
    // 直接重画一级菜单，不走 showActionMenu 的 toggle 分支
    closeActionMenu();
    showActionMenu();
  } });
  body.appendChild(back);
  body.appendChild(el('div', { class: 'action-menu-head', text: title }));
  render(body);
}

function renderCoinSub(body, bvid) {
  enterSub(body, '投币', (b) => {
    [1, 2].forEach((n) => {
      b.appendChild(el('div', {
        class: 'action-option',
        onclick: () => {
          const v = currentVideo();
          doAction(b, '投币', () => bili.coin({ bvid, aid: v.aid, count: n }), `已投 ${n} 枚硬币`);
        },
      }, `投 ${n} 币`));
    });
    b.appendChild(el('div', { class: 'action-menu-tip', text: '每个视频最多投 2 币，且只能投一次' }));
  });
}

function renderFavSub(body, bvid) {
  enterSub(body, '收藏', (b) => {
    b.appendChild(el('div', { class: 'action-menu-tip', text: '正在读取收藏夹…' }));
    bili.favFolders({}).then((res) => {
      const tip = b.querySelector('.action-menu-tip');
      if (tip) tip.remove();
      const folders = (res.ok && res.data?.folders) || [];
      if (!folders.length) {
        b.appendChild(el('div', { class: 'action-menu-tip', text: '未读到收藏夹，将收藏到默认收藏夹' }));
      }
      const chosen = new Set();
      folders.slice(0, 20).forEach((f) => {
        const row = el('div', { class: 'action-option fav-option' }, [
          el('span', { class: 'fav-check', text: '☐' }),
          el('span', { text: `${f.title || '收藏夹'}（${f.mediaCount ?? 0}）` }),
        ]);
        row.onclick = () => {
          if (chosen.has(f.id)) { chosen.delete(f.id); row.querySelector('.fav-check').textContent = '☐'; row.classList.remove('on'); }
          else { chosen.add(f.id); row.querySelector('.fav-check').textContent = '☑'; row.classList.add('on'); }
        };
        b.appendChild(row);
      });
      const btn = el('button', {
        class: 'btn primary action-apply',
        text: '收藏',
        onclick: () => {
          const v = currentVideo();
          doAction(b, '收藏', () => bili.favorite({ bvid, aid: v.aid, mediaIds: [...chosen] }), chosen.size ? `已收藏到 ${chosen.size} 个收藏夹` : '已收藏到默认收藏夹');
        },
      });
      b.appendChild(btn);
      b.appendChild(el('div', { class: 'action-menu-tip', text: '不勾选 = 默认收藏夹' }));
    }).catch(() => {
      const tip = b.querySelector('.action-menu-tip');
      if (tip) tip.textContent = '收藏夹读取失败，可仍用默认收藏夹';
      b.appendChild(el('button', {
        class: 'btn primary action-apply', text: '收藏到默认收藏夹',
        onclick: () => {
          const v = currentVideo();
          doAction(b, '收藏', () => bili.favorite({ bvid, aid: v.aid, mediaIds: [] }), '已收藏到默认收藏夹');
        },
      }));
    });
  });
}

function renderFollowSub(body, bvid) {
  enterSub(body, '关注作者', (b) => {
    const v = currentVideo();
    if (!v.mid) {
      b.appendChild(el('div', { class: 'action-menu-tip', text: '正在读取作者信息…请稍后重试，或从搜索/推荐列表重新点开视频' }));
      return;
    }
    b.appendChild(el('div', { class: 'action-option', onclick: () => doAction(b, '关注', () => bili.follow({ mid: v.mid, act: 1 }), '已关注作者', () => { actionState.following = true; }) }, '关注'));
    b.appendChild(el('div', { class: 'action-option', onclick: () => doAction(b, '取关', () => bili.follow({ mid: v.mid, act: 2 }), '已取消关注', () => { actionState.following = false; }) }, '取关'));
    b.appendChild(el('div', { class: 'action-menu-tip', text: v.author || `mid ${v.mid}` }));
  });
}

/** 统一执行：防连点、成功/失败 toast、错误码人话 */
function doAction(body, label, call, successMsg, onSuccess) {
  const tip = body.querySelector('.action-menu-tip') || el('div', { class: 'action-menu-tip' });
  if (!tip.parentNode) body.appendChild(tip);
  tip.textContent = '处理中…';
  body.querySelectorAll('.action-option, .action-apply, .btn').forEach((n) => { n.style.pointerEvents = 'none'; n.style.opacity = '.6'; });
  Promise.resolve()
    .then(call)
    .then((res) => {
      if (!res || res.ok === false) throw Object.assign(new Error(res?.error || `${label}失败`), { code: res?.code, reason: res?.reason });
      toast.success(successMsg || `${label}成功`);
      tip.textContent = successMsg || `${label}成功`;
      if (onSuccess) onSuccess();
    })
    .catch((e) => {
      const msg = actionErrorMessage(label, e);
      toast.error(msg);
      tip.textContent = msg;
      tip.classList.add('err');
    });
}

function actionErrorMessage(label, e) {
  const c = e && e.code;
  if (c === -101 || c === 'need_login' || e.reason === 'need_login') return '未登录：请先在设置里登录 B 站账号';
  if (c === 'NEED_CSRF' || c === -111 || e.reason === 'need_csrf') return '登录信息不完整（缺 bili_jct），请重新登录';
  if (c === -412 || e.reason === 'risk') return '请求被 B 站风控拦截，请稍后再试';
  if (c === -509 || e.reason === 'rate_limited') return '操作太频繁，请稍后再试';
  if (c === 34005) return '这个视频已经投过币了';
  if (c === 34004) return '硬币不足，明天再来吧';
  if (c === 34002) return '不能给自己投币哦';
  if (c === 34003) return 'UP 主未开放投币';
  if (c === 11202) return '已经收藏过啦';
  if (c === 22002) return '不能关注自己';
  return (e && e.message) || `${label}失败，请稍后重试`;
}

function showRateMenu() {
  const body = el('div', { class: 'rate-menu' });
  RATES.forEach((r) => {
    body.appendChild(
      el('button', {
        class: 'btn' + (Math.abs(store.get().rate - r) < 0.01 ? ' primary' : ''),
        text: Number(r.toFixed(2)) + '×',
        onclick: async () => {
          setRate(r);
          body.remove();
          toast.info(`播放速度 ${Number(r.toFixed(2))}×`);
        },
      }),
    );
  });
  ui.secondary.appendChild(body);
  setTimeout(() => {
    const off = (ev) => {
      if (!body.contains(ev.target)) {
        body.remove();
        document.removeEventListener('click', off);
      }
    };
    document.addEventListener('click', off);
  }, 0);
}

function showSleepMenu() {
  const opts = [
    { label: '15 分钟', min: 15 },
    { label: '30 分钟', min: 30 },
    { label: '45 分钟', min: 45 },
    { label: '60 分钟', min: 60 },
    { label: '90 分钟', min: 90 },
    { label: '播完当前曲目', min: -1 },
    { label: '关闭定时', min: 0 },
  ];
  const body = el('div', { class: 'rate-menu' });
  opts.forEach((o) => {
    body.appendChild(
      el('button', {
        class: 'btn' + (o.min === 0 ? ' ghost' : ''),
        text: o.label,
        onclick: () => {
          if (o.min === 0) {
            stopSleepTimer();
            cancelPauseAfterCurrent();
            toast.info('定时关闭已取消');
          } else if (o.min === -1) {
            pauseAfterCurrentTrack();
            toast.success('将在当前曲目播完后暂停');
          } else {
            startSleepTimer(o.min);
            toast.success(`已设置 ${o.label}后停止播放`);
          }
          body.remove();
        },
      }),
    );
  });
  ui.secondary.appendChild(body);
  setTimeout(() => {
    const off = (ev) => {
      if (!body.contains(ev.target)) {
        body.remove();
        document.removeEventListener('click', off);
      }
    };
    document.addEventListener('click', off);
  }, 0);
}
