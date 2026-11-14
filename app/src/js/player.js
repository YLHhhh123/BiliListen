// ===== player.js：音频播放内核 =====
// 用 HTMLAudioElement 封装，src 必须用 bili.playurl 返回的 localUrl。

import { bili } from './api.js';
import { store, playHistory } from './store.js';
import { toast } from './components/toast.js';

const audio = new Audio();
audio.preload = 'auto';
// 不要设 crossOrigin，本地代理已带 CORS

let lastVolume = 0.8;
let retryCount = 0;
let currentKey = '';       // 当前播放 bvid_cid
let prefetchTimer = null;
let pendingSeek = 0;       // 加载完成后要跳到的秒数（断点续播用）

// 倍速档位：对齐手机版 B 站「听视频」PodcastSpeedSeekBar（6 档，默认 1.0）
export const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

// 「播完当前曲目后暂停」放进 store，播放器与 UI 只认这一份状态；
// 仍然是内存态，session.js 不会把它落盘，重启自然清空。

// ---------- 加载配置 ----------
export async function initPlayer() {
  const cfg = store.get().config || {};
  audio.volume = cfg.volume ?? 0.8;
  audio.playbackRate = cfg.rate ?? 1.0;
  lastVolume = audio.volume;

  audio.addEventListener('loadedmetadata', () => {
    store.set({ duration: audio.duration || 0, buffering: false });
    if (pendingSeek > 1 && audio.duration > 2) {
      // 上次已经听到结尾了就别再停在结尾，从头来
      const done = pendingSeek >= audio.duration - 3;
      const to = done ? 0 : Math.min(pendingSeek, Math.max(0, audio.duration - 1));
      audio.currentTime = to;
      store.set({ currentTime: to, progress: to / audio.duration });
    }
    pendingSeek = 0;
  });

  audio.addEventListener('timeupdate', () => {
    const cur = audio.currentTime;
    const dur = audio.duration || 0;
    store.set({
      currentTime: cur,
      progress: dur > 0 ? cur / dur : 0,
    });
    // 90% 预取下一首
    const cfg2 = store.get().config || {};
    if (cfg2.autoNext && dur > 0 && cur / dur > 0.9 && !prefetchTimer) {
      prefetchTimer = setTimeout(() => prefetchNext(), 500);
    }
  });

  audio.addEventListener('waiting', () => store.set({ buffering: true }));
  audio.addEventListener('playing', () => {
    store.set({ isPlaying: true, buffering: false });
    reportState();
  });
  audio.addEventListener('pause', () => {
    store.set({ isPlaying: false });
    reportState();
  });

  audio.addEventListener('ended', () => {
    // 地址过期错误：audio.error 非空时重新拿地址
    if (audio.error) {
      retryPlayUrl();
      return;
    }
    handleEnded();
  });

  audio.addEventListener('error', () => {
    console.warn('[player] audio error', audio.error);
    if (retryCount < 1) {
      retryCount++;
      toast.info('播放失败，正在重试…');
      retryPlayUrl();
    } else {
      retryCount = 0;
      store.set({ buffering: false, isPlaying: false });
      toast.error('播放失败，可能已过期，点击重试');
    }
  });

  // 音量/倍速持久化
  store.subscribe((s) => {
    if (audio.volume !== s.volume) audio.volume = s.volume;
    if (audio.playbackRate !== s.rate) audio.playbackRate = s.rate;
  });
}

function reportState() {
  const s = store.get();
  bili.reportPlayerState({
    playing: s.isPlaying,
    title: s.playing?.title || '',
  });
}

/** 重新拉 playurl 并重试（地址过期场景） */
async function retryPlayUrl() {
  const p = store.get().playing;
  if (!p) return;
  const res = await bili.playurl({ bvid: p.bvid, cid: p.cid });
  if (!res.ok) {
    toast.error(res.error || '获取播放地址失败');
    return;
  }
  audio.src = res.data.localUrl;
  audio.play().catch(() => {});
}

/** 静默预取下一首的 localUrl（不更新 audio.src） */
async function prefetchNext() {
  const s = store.get();
  const next = getNextItem(false);
  if (!next) { prefetchTimer = null; return; }
  try {
    await bili.playurl({ bvid: next.bvid, cid: next.cid });
  } catch {}
  prefetchTimer = null;
}

// ---------- 播放控制 ----------

/** 播放一个视频项（先拉 video 详情取 cid，再拉 playurl） */
export async function playVideo(item, opts = {}) {
  // item: {bvid, cid?, title, author, cover, duration}
  // opts.startAt: 从第几秒开始（断点续播 / 历史记录点进来）
  if (!item.bvid) return;
  let cid = item.cid;
  if (!cid) {
    const v = await bili.video({ bvid: item.bvid });
    if (!v.ok) { toast.error(v.error || '获取视频信息失败'); return; }
    cid = v.data.cid || (v.data.pages?.[0]?.cid);
    if (!item.title) item.title = v.data.title;
    if (!item.cover) item.cover = v.data.cover;
    if (!item.author) item.author = v.data.owner?.name;
    if (item.duration == null) item.duration = v.data.duration;
  }

  const key = `${item.bvid}_${cid}`;
  currentKey = key;
  retryCount = 0;
  prefetchTimer = null;
  const seekStart = Math.max(0, Number(opts.startAt) || 0);
  pendingSeek = seekStart;

  // 找它在队列中的位置。自动目录里的 cid 会先留空，解析到真实 cid 后要
  // 回写原队列项；否则严格按 cid 匹配会把同一个视频再插一遍，造成首项重复。
  const queue = store.get().queue.slice();
  let idx = queue.findIndex((q) => q.bvid === item.bvid && (!q.cid || q.cid === cid));
  if (idx < 0) {
    // 不在队列里，插到当前位置之后
    const cur = store.get().currentIndex;
    const insertPos = cur >= 0 ? cur + 1 : queue.length;
    queue.splice(insertPos, 0, {
      key, bvid: item.bvid, cid,
      title: item.title, author: item.author, cover: item.cover, duration: item.duration,
    });
    idx = insertPos;
  } else {
    const old = queue[idx];
    queue[idx] = {
      ...old,
      key,
      cid,
      title: item.title || old.title,
      author: item.author || old.author,
      cover: item.cover || old.cover,
      duration: item.duration || old.duration,
    };
  }
  store.set({ queue, currentIndex: idx });

  store.set({
    playing: { ...item, cid, key },
    buffering: true,
    lyrics: [],
  });

  const res = await bili.playurl({ bvid: item.bvid, cid });
  if (!res.ok) {
    store.set({ buffering: false });
    toast.error(res.error || '获取播放地址失败');
    return;
  }
  audio.src = res.data.localUrl;
  audio.play().then(() => {
    store.set({ isPlaying: true, buffering: false });
  }).catch((e) => {
    console.warn('[player] play rejected', e);
    store.set({ isPlaying: false, buffering: false });
  });

  // 拉字幕（歌词）
  loadLyrics(item.bvid, cid);

  // 写本地历史
  playHistory.upsert({
    bvid: item.bvid, cid,
    title: item.title, author: item.author,
    cover: item.cover, duration: item.duration,
    lastPos: Math.floor(seekStart),
  });
}

async function loadLyrics(bvid, cid) {
  const res = await bili.subtitle({ bvid, cid });
  if (res.ok && res.data?.ok && res.data.lines?.length) {
    store.set({ lyrics: res.data.lines, lyricsStatus: 'ok' });
    return;
  }
  // 区分「真没字幕」和「获取失败」：以前一律塞空数组，用户只看到「暂无歌词」，
  // 登录过期 / 接口报错 / 风控全被吞掉。现在把原因交给 UI 显示。
  const d = res.ok ? res.data : null;
  const reason = d?.reason || (res.ok ? '' : 'request_failed');
  store.set({
    lyrics: [],
    lyricsStatus: reason === 'no_subtitle' ? 'empty' : 'error',
    lyricsMessage: d?.message || res.error || (reason === 'need_login' ? '该视频有字幕，请登录后查看' : '字幕获取失败'),
  });
}

/** 播放队列中指定索引的项 */
export function playQueueIndex(idx) {
  const queue = store.get().queue;
  if (idx < 0 || idx >= queue.length) return;
  playVideo(queue[idx]);
}

/**
 * 还原上次退出时的播放现场（不自动出声）。
 * 只把队列 / 当前曲目 / 秒数摆回界面；音频地址要等用户点播放时再取，
 * 因为 B 站的 playurl 带签名和有效期，存下来第二天就失效了。
 */
export function restoreSession(session) {
  if (!session || typeof session !== 'object') return null;
  const queue = (Array.isArray(session.queue) ? session.queue : []).filter((q) => q && q.bvid);
  const playing = session.playing && session.playing.bvid ? session.playing : null;
  if (!playing && queue.length === 0) return null;
  const currentIndex = Number.isInteger(session.currentIndex) ? session.currentIndex : -1;
  const pos = Math.max(0, Number(session.position) || 0);
  const dur = Number(playing?.duration) || 0;
  if (playing) {
    currentKey = `${playing.bvid}_${playing.cid || 0}`;
    pendingSeek = pos;
  }
  store.set({
    queue,
    currentIndex,
    playing,
    currentTime: pos,
    duration: dur,
    progress: dur > 0 ? Math.min(1, pos / dur) : 0,
    isPlaying: false,
    buffering: false,
  });
  return { playing, queue, position: pos };
}

export function togglePlay() {
  const s = store.get();
  if (!s.playing) return;
  // 还原现场后 audio.src 还是空的：这时点播放要重新取地址，并从断点开始
  if (!audio.src) {
    playVideo(s.playing, { startAt: s.currentTime || 0 });
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function seek(ratio) {
  const s = store.get();
  // 还没取到音频地址（刚还原现场）：只挪界面上的进度，点播放时按这个位置开始
  if (!audio.src) {
    const dur = s.duration || s.playing?.duration || 0;
    if (!dur) return;
    const t = Math.max(0, Math.min(dur, ratio * dur));
    pendingSeek = t;
    store.set({ currentTime: t, progress: dur > 0 ? t / dur : 0 });
    return;
  }
  const dur = audio.duration;
  if (!dur) return;
  audio.currentTime = Math.max(0, Math.min(dur, ratio * dur));
}

export function seekBy(delta) {
  if (!audio.src) {
    const s = store.get();
    const dur = s.duration || s.playing?.duration || 0;
    if (!dur) return;
    const t = Math.max(0, Math.min(dur, (s.currentTime || 0) + delta));
    pendingSeek = t;
    store.set({ currentTime: t, progress: t / dur });
    return;
  }
  audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
}

export function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  if (v > 0) lastVolume = v;
  store.set({ volume: v });
  persistConfig({ volume: v });
}

export function toggleMute() {
  const cur = audio.volume;
  if (cur > 0) store.set({ volume: 0 });
  else store.set({ volume: lastVolume });
}

export function setRate(r) {
  store.set({ rate: r });
  persistConfig({ rate: r });
}

export function nextRate() {
  const cur = store.get().rate;
  const idx = RATES.indexOf(cur);
  setRate(RATES[(idx + 1) % RATES.length]);
}

/** 设置「播完当前曲目后暂停」：ended 时不自动播下一首 */
export function pauseAfterCurrentTrack() {
  store.set({ pauseAfterCurrent: true });
}

/** 取消「播完当前暂停」标志（关闭定时用） */
export function cancelPauseAfterCurrent() {
  store.set({ pauseAfterCurrent: false });
}

const PLAY_MODES = ['order', 'loop', 'single', 'shuffle'];
export function cycleMode() {
  const cur = store.get().playMode;
  const idx = PLAY_MODES.indexOf(cur);
  const next = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
  store.set({ playMode: next });
  persistConfig({ playMode: next });
}

/** 取下一项（不实际播放）。actualNext=true 时返回下一首要播的（受模式影响） */
function getNextItem(actualNext = true) {
  const { queue, currentIndex, playMode } = store.get();
  if (queue.length === 0) return null;
  if (currentIndex < 0) return queue[0];

  if (playMode === 'single') return actualNext ? queue[currentIndex] : null;
  if (playMode === 'shuffle') {
    if (queue.length === 1) return queue[0];
    let i;
    do { i = Math.floor(Math.random() * queue.length); } while (i === currentIndex);
    return queue[i];
  }
  // order / loop
  if (currentIndex < queue.length - 1) return queue[currentIndex + 1];
  if (playMode === 'loop') return queue[0];
  return null; // order 到队尾
}

/** 上一项 */
function getPrevItem() {
  const { queue, currentIndex, playMode } = store.get();
  if (queue.length === 0) return null;
  if (currentIndex <= 0) return playMode === 'loop' ? queue[queue.length - 1] : queue[0];
  return queue[currentIndex - 1];
}

function handleEnded() {
  // 定时关闭的「播完当前」：播完本曲就停，不进下一首。
  // 该分支触发时顺带清掉数字定时（若也在倒计时）——二者语义是「同一次定时关闭」，
  // 留着会让下一次手动播放被残留的倒计时打断。
  if (store.get().pauseAfterCurrent) {
    stopSleepTimer(false);
    audio.pause();
    store.set({ isPlaying: false });
    toast.info('本曲已播完，已按定时设置暂停');
    return;
  }
  const next = getNextItem(true);
  if (next) playVideo(next);
  else store.set({ isPlaying: false });
}

export function nextTrack() {
  const next = getNextItem(true);
  if (next) playVideo(next);
  else toast.info('已经是最后一首了');
}

export function prevTrack() {
  const prev = getPrevItem();
  if (prev) playVideo(prev);
}

/** 加入队列（不自动播） */
export function addToQueue(item) {
  const queue = store.get().queue.slice();
  queue.push({
    key: `${item.bvid}_${item.cid || 0}`,
    bvid: item.bvid, cid: item.cid,
    title: item.title, author: item.author,
    cover: item.cover, duration: item.duration,
  });
  store.set({ queue });
}

/** 移除队列项 */
export function removeFromQueue(idx) {
  const { queue, currentIndex } = store.get();
  const newQueue = queue.filter((_, i) => i !== idx);
  let newCur = currentIndex;
  if (idx < currentIndex) newCur = currentIndex - 1;
  else if (idx === currentIndex) {
    // 移除当前播放项
    if (newQueue.length === 0) {
      audio.pause();
      store.set({ queue: newQueue, currentIndex: -1, playing: null, isPlaying: false });
      return;
    }
    newCur = Math.min(idx, newQueue.length - 1);
  }
  store.set({ queue: newQueue, currentIndex: newCur });
}

/** 清空队列 */
export function clearQueue() {
  audio.pause();
  store.set({ queue: [], currentIndex: -1, playing: null, isPlaying: false });
}

/** 队列拖拽排序：把 from 移到 to 之前/之后 */
export function reorderQueue(fromIdx, toIdx, position = 'before') {
  const { queue, currentIndex } = store.get();
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
  const item = queue[fromIdx];
  const newQueue = queue.filter((_, i) => i !== fromIdx);
  let insertAt = toIdx;
  if (fromIdx < toIdx) insertAt = toIdx - 1; // 移除后索引偏移
  if (position === 'after') insertAt += 1;
  insertAt = Math.max(0, Math.min(newQueue.length, insertAt));
  newQueue.splice(insertAt, 0, item);

  const playingBvid = queue[currentIndex]?.bvid;
  const playingCid = queue[currentIndex]?.cid;
  const newCur = newQueue.findIndex((q) => q.bvid === playingBvid && q.cid === playingCid);
  store.set({ queue: newQueue, currentIndex: newCur });
}

export function getAudio() { return audio; }
export function getCurrentKey() { return currentKey; }

async function persistConfig(patch) {
  try { await bili.setConfig(patch); } catch {}
}

// 定时关闭（双模式）
//   endOfTrack：播完当前曲目暂停（不倒计时）
//   timer     ：N 分钟后暂停（倒计时）
// 两个开关互相独立、可同时启用；任意一个触发后，另一个也一并清掉。
// prevCountsPrev 留 true：重开定时不清旧标志；手动「关闭定时」传 false，一次清干净。
let sleepInterval = null;
export function startSleepTimer(minutes) {
  stopSleepTimer(true);
  if (!(minutes > 0)) return;
  const target = Date.now() + minutes * 60 * 1000;
  store.set({ sleepTimer: target, sleepRemaining: minutes * 60 });
  sleepInterval = setInterval(() => {
    const remain = Math.max(0, Math.floor((target - Date.now()) / 1000));
    store.set({ sleepRemaining: remain });
    if (remain <= 0) {
      // 数字定时到点：停表 + 清「播完当前」标志，然后淡出暂停
      stopSleepTimer(false);
      cancelPauseAfterCurrent();
      fadeOutAndPause();
    }
  }, 1000);
}

export function stopSleepTimer(keepEndOfTrack = true) {
  if (sleepInterval) { clearInterval(sleepInterval); sleepInterval = null; }
  store.set({ sleepTimer: 0, sleepRemaining: 0 });
  // 手动关闭（keepEndOfTrack=false）时连「播完当前暂停」一起取消；
  // 重开数字定时（true）时不碰它 —— 允许「播完当前 + N 分钟」并存。
  if (!keepEndOfTrack) cancelPauseAfterCurrent();
}

function fadeOutAndPause() {
  const startVol = audio.volume;
  const steps = 30;
  let step = 0;
  const t = setInterval(() => {
    step++;
    audio.volume = Math.max(0, startVol * (1 - step / steps));
    if (step >= steps) {
      clearInterval(t);
      audio.pause();
      audio.volume = startVol;
      toast.info('定时关闭已到，已暂停播放');
    }
  }, 100);
}
