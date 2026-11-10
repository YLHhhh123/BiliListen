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

  // 次要控制：倍速 / 音量 / 定时
  const rateBtn = el('button', { class: 'btn ghost', text: '1.0×', onclick: showRateMenu });
  const volBtn = iconBtn(ICONS.volume, '静音', () => {
    const s = store.get();
    setVolume(s.volume > 0 ? 0 : 0.8);
  });
  const sleepBtn = el('button', { class: 'btn ghost', text: '定时关闭', onclick: showSleepMenu });
  const secondary = el('div', { class: 'np-secondary' }, [rateBtn, volBtn, sleepBtn]);

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
  if (lines !== lyricLines && JSON.stringify(lines.slice(0, 2)) !== JSON.stringify(lyricLines.slice(0, 2))) {
    lyricLines = lines;
    lyricIdx = -1;
    ui.lyricInner.innerHTML = '';
    if (!lines.length) {
      ui.lyricInner.appendChild(el('div', { class: 'lyric-empty', text: '暂无歌词' }));
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
