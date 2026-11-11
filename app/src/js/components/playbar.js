// ===== playbar.js：底部播放条 =====

import { el, svg, fmtDuration } from '../utils.js';
import { store } from '../store.js';
import { bili } from '../api.js';
import { togglePlay, seek, setVolume, setRate, toggleMute, cycleMode, prevTrack, nextTrack, startSleepTimer, stopSleepTimer, pauseAfterCurrentTrack, cancelPauseAfterCurrent, RATES } from '../player.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  mode_order: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4zm12 0v-3l4 4-4 4v-3h-4v-2h4z',
  mode_loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  mode_single: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  mode_shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  expand: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
};

const MODE_ICON = {
  order: ICONS.mode_order,
  loop: ICONS.mode_loop,
  single: ICONS.mode_single,
  shuffle: ICONS.mode_shuffle,
};
const MODE_LABEL = { order: '顺序', loop: '循环', single: '单曲', shuffle: '随机' };

export function mountPlaybar() {
  const root = document.getElementById('playbar');
  root.innerHTML = '';

  // 左侧封面 + 信息
  const cover = el('div', { class: 'playbar-cover empty', id: 'pb-cover' }, [
    svg('M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z', { size: 24, fill: 'var(--text-3)' }),
  ]);
  cover.addEventListener('click', () => {
    if (store.get().playing) store.set({ nowPlayingOpen: true });
  });
  const info = el('div', { class: 'playbar-info' }, [
    el('div', { class: 'playbar-title clamp-1', id: 'pb-title' }, '选择一首开始听'),
    el('div', { class: 'playbar-author clamp-1', id: 'pb-author' }, ''),
  ]);

  // 中间控制
  const progressBubble = el('span', { class: 'progress-bubble' }, '00:00');
  const progressThumb = el('div', { class: 'progress-thumb' });
  const progressFill = el('div', { class: 'progress-fill', id: 'pb-prog-fill' });
  const progressTrack = el('div', { class: 'progress-track', id: 'pb-prog' },
    [progressFill, progressThumb, progressBubble]);

  bindProgress(progressTrack, progressFill, progressThumb, progressBubble);

  const curTime = el('span', { class: 'tabular-nums', id: 'pb-cur' }, '00:00');
  const durTime = el('span', { class: 'tabular-nums', id: 'pb-dur' }, '00:00');
  const progressRow = el('div', { class: 'playbar-progress' }, [curTime, progressTrack, durTime]);

  const modeBtn = el('div', { class: 'ctrl-btn', id: 'pb-mode', title: '顺序', onclick: cycleMode },
    [svg(MODE_ICON.order, { size: 18 })]);
  const prevBtn = el('div', { class: 'ctrl-btn', title: '上一首', onclick: prevTrack },
    [svg(ICONS.prev, { size: 18 })]);
  const playBtn = el('div', { class: 'ctrl-btn play', id: 'pb-play', title: '播放', onclick: togglePlay },
    [svg(ICONS.play, { size: 20 })]);
  const nextBtn = el('div', { class: 'ctrl-btn', title: '下一首', onclick: nextTrack },
    [svg(ICONS.next, { size: 18 })]);
  const queueBtn = el('div', { class: 'ctrl-btn', title: '队列', onclick: () => store.set({ queueOpen: true }) },
    [svg(ICONS.list, { size: 18 })]);

  const controls = el('div', { class: 'playbar-controls' },
    [modeBtn, prevBtn, playBtn, nextBtn, queueBtn]);

  const center = el('div', { class: 'playbar-center' }, [controls, progressRow]);

  // 右侧：倍速 / 定时 / 音量
  // 倍速列表选择：把原生 select 透明铺在徽标上，点徽标即弹原生下拉（Chromium 下
  // select.click() 程序化展开不可靠，覆盖式是稳的）。选完走 setRate 持久化。
  const rateBadge = el('div', {
    class: 'rate-badge', id: 'pb-rate',
    title: '倍速（点击选择）',
  }, '1.0x');
  const rateSelect = el('select', {
    class: 'rate-select', id: 'pb-rate-select',
    title: '播放倍速',
    onchange: () => {
      const r = Number(rateSelect.value);
      if (RATES.includes(r)) setRate(r);
    },
  }, RATES.map((r) => el('option', { value: r }, r + 'x')));
  rateSelect.value = String(store.get().rate ?? 1);
  if (rateSelect.selectedIndex < 0) rateSelect.value = '1';
  const rateWrap = el('div', { class: 'rate-wrap', title: '倍速（点击选择）' }, [rateBadge, rateSelect]);
  const sleepBadge = el('div', {
    class: 'sleep-badge', id: 'pb-sleep',
    onclick: openSleepModal,
    title: '定时关闭',
  }, '⏰');
  const volBtn = el('div', { class: 'ctrl-btn', id: 'pb-vol-btn', onclick: toggleMute },
    [svg(ICONS.volume, { size: 16 })]);
  const volFill = el('div', { class: 'volume-fill', id: 'pb-vol-fill', style: { width: '80%' } });
  const volSlider = el('div', { class: 'volume-slider', id: 'pb-vol' }, [volFill]);
  bindVolume(volSlider, volFill);
  const expandBtn = el('div', {
    class: 'ctrl-btn', title: '全屏播放',
    onclick: () => store.get().playing && store.set({ nowPlayingOpen: true }),
  }, [svg(ICONS.expand, { size: 16 })]);

  const right = el('div', { class: 'playbar-right' },
    [rateWrap, sleepBadge, volBtn, volSlider, expandBtn]);

  root.append(cover, info, center, right);

  // 订阅状态
  store.subscribe(renderPlaybar);
  renderPlaybar(store.get());
}

function bindProgress(track, fill, thumb, bubble) {
  let dragging = false;
  const update = (clientX) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    fill.style.width = (ratio * 100) + '%';
    thumb.style.left = (ratio * 100) + '%';
    const dur = store.get().duration;
    bubble.textContent = fmtDuration(ratio * dur);
    bubble.style.left = (ratio * 100) + '%';
    return ratio;
  };
  track.addEventListener('mousedown', (e) => {
    dragging = true;
    update(e.clientX);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    update(e.clientX);
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const ratio = update(e.clientX);
    seek(ratio);
  });
  track.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const dur = store.get().duration;
    bubble.textContent = fmtDuration(ratio * dur);
    bubble.style.left = (ratio * 100) + '%';
  });
}

function bindVolume(slider, fill) {
  let dragging = false;
  const update = (clientX) => {
    const rect = slider.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    fill.style.width = (ratio * 100) + '%';
    setVolume(ratio);
  };
  slider.addEventListener('mousedown', (e) => { dragging = true; update(e.clientX); });
  window.addEventListener('mousemove', (e) => { if (dragging) update(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });
}

function renderPlaybar(s) {
  const cover = document.getElementById('pb-cover');
  const title = document.getElementById('pb-title');
  const author = document.getElementById('pb-author');
  const playBtn = document.getElementById('pb-play');
  const modeBtn = document.getElementById('pb-mode');
  const rateBadge = document.getElementById('pb-rate');
  const sleepBadge = document.getElementById('pb-sleep');
  const volBtn = document.getElementById('pb-vol-btn');
  const volFill = document.getElementById('pb-vol-fill');
  const progFill = document.getElementById('pb-prog-fill');
  const curEl = document.getElementById('pb-cur');
  const durEl = document.getElementById('pb-dur');

  if (s.playing) {
    cover.classList.remove('empty');
    cover.innerHTML = '';
    if (s.playing.cover) {
      // 走本地图片代理（hdslb 校验 Referer，直连会 403）
      bili.img(s.playing.cover).then((res) => {
        const u = res?.ok ? res.data?.url : s.playing.cover;
        cover.style.backgroundImage = `url("${u}")`;
      }).catch(() => { cover.style.backgroundImage = `url("${s.playing.cover}")`; });
    }
    title.textContent = s.playing.title || '';
    author.textContent = s.playing.author || '';
  }

  if (playBtn) {
    playBtn.innerHTML = '';
    playBtn.appendChild(svg(s.isPlaying ? ICONS.pause : ICONS.play, { size: 20 }));
  }
  if (modeBtn) {
    modeBtn.innerHTML = '';
    modeBtn.title = MODE_LABEL[s.playMode] || '顺序';
    modeBtn.appendChild(svg(MODE_ICON[s.playMode] || MODE_ICON.order, { size: 18 }));
  }
  if (rateBadge) {
    rateBadge.textContent = s.rate + 'x';
    // store.rate 可能被设置页滑杆改过，同步回下拉；找不到对应档位时保持原样
    const sel = document.getElementById('pb-rate-select');
    if (sel && RATES.includes(s.rate)) sel.value = String(s.rate);
  }
  if (sleepBadge) {
    const hasTimer = s.sleepRemaining > 0;
    const hasEndOfTrack = !!s.pauseAfterCurrent;
    if (hasTimer) {
      const m = Math.floor(s.sleepRemaining / 60);
      const sec = s.sleepRemaining % 60;
      const base = `⏰ ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      sleepBadge.textContent = hasEndOfTrack ? base + ' ·播完' : base;
      sleepBadge.classList.add('active');
    } else if (hasEndOfTrack) {
      sleepBadge.textContent = '⏰ 播完暂停';
      sleepBadge.classList.add('active');
    } else {
      sleepBadge.textContent = '⏰';
      sleepBadge.classList.remove('active');
    }
  }
  if (volBtn) {
    volBtn.innerHTML = '';
    volBtn.appendChild(svg(s.volume > 0 ? ICONS.volume : ICONS.mute, { size: 16 }));
  }
  if (volFill) volFill.style.width = (s.volume * 100) + '%';
  if (progFill) progFill.style.width = (s.progress * 100) + '%';
  if (curEl) curEl.textContent = fmtDuration(s.currentTime);
  if (durEl) durEl.textContent = fmtDuration(s.duration);
}

function openSleepModal() {
  const s = store.get();
  // 两个开关可同时勾选，先到者触发：
  //   A. 播完当前曲目后暂停（无倒计时，等 ended 事件）
  //   B. N 分钟后暂停（倒计时，淡出暂停）
  // 任一触发后另一个自动清掉（见 player.js 的 handleEnded / sleepInterval）。
  const chkEot = el('input', { type: 'checkbox' });
  chkEot.checked = !!s.pauseAfterCurrent;
  const chkTimer = el('input', { type: 'checkbox' });
  chkTimer.checked = (s.sleepRemaining || 0) > 0;

  const minsSel = el('select', { class: 'btn', style: { width: '110px' } },
    [15, 30, 45, 60, 90, 120].map((m) => el('option', { value: m }, m + ' 分钟')));
  minsSel.value = '30';

  const row = (ctrl, label, desc) => el('label', {
    style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', padding: '4px 0' },
  }, [
    ctrl,
    el('div', {}, [
      el('div', {}, label),
      el('div', { style: { fontSize: '12px', color: 'var(--text-3, #888)' } }, desc),
    ]),
  ]);

  const timerRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
    [chkTimer, el('div', {}, [
      el('div', {}, '定时暂停'),
      el('div', { style: { fontSize: '12px', color: 'var(--text-3, #888)', marginTop: 4 } }, minsSel),
    ])]);
  // 点「定时暂停」文字行也能勾选：让整行 label 拦截，勾选框单独渲染
  timerRow.style.cursor = 'pointer';

  const applyBtn = el('button', {
    class: 'btn',
    onclick: () => {
      const eot = chkEot.checked;
      const timed = chkTimer.checked;
      // 全关：手动关闭，把两个标志都清掉
      if (!eot && !timed) {
        stopSleepTimer(false);
        toast.info('已关闭定时');
      } else {
        // 重开数字定时（不清「播完当前」标志）；没勾数字定时就只清倒计时本身
        stopSleepTimer(true);
        if (eot) { pauseAfterCurrentTrack(); toast.success(eot && timed ? '将在播完当前曲目或定时到时暂停（先到为准）' : '将在当前曲目播完后暂停'); }
        else cancelPauseAfterCurrent();
        if (timed) startSleepTimer(Number(minsSel.value));
      }
      closeModal();
    },
  }, '确定');
  const cancelBtn = el('button', { class: 'btn ghost', onclick: closeModal }, '取消');

  openModal({
    title: '定时关闭',
    body: el('div', { style: { display: 'grid', gap: 10 } }, [
      el('p', { style: { margin: 0, fontSize: '12px', color: 'var(--text-3, #888)' } },
        '两个开关可同时启用，先到者生效；任意一个触发后另一个自动取消。'),
      row(chkEot, '播完当前曲目后暂停', '听完当前这一首就停，不切下一首'),
      timerRow,
    ]),
    footer: [cancelBtn, applyBtn],
  });
}
