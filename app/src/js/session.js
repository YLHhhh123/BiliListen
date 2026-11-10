// ===== session.js：把「听到哪了」写回磁盘 =====
// 存的是播放现场快照：队列 + 当前曲目 + 秒数 + 所在页面。
// 分两档节流：
//   · 队列/曲目变了（结构变化）800ms 内落盘
//   · 播放进度 5s 一次，避免每秒写盘
// 关闭窗口/刷新时用同步 IPC 强制落盘，保证「关掉再开」位置不丢。

import { bili } from './api.js';
import { store } from './store.js';

const STRUCT_DELAY = 800;
const POS_DELAY = 5000;

let structTimer = null;
let posTimer = null;
let lastStructSig = '';
let lastSavedAt = 0;
/**
 * 是否真的产生过播放内容。
 * 没有这个标记的话，「打开应用啥也没听就关掉」会用一个空快照把上次的队列/断点覆盖掉。
 */
let everHadContent = false;

/** 只存必要字段，避免把整个 item（可能带 pages 等大对象）写进配置 */
function slimQueue(list) {
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && q.bvid)
    .map((q) => ({
      key: q.key,
      bvid: q.bvid,
      cid: q.cid,
      title: q.title,
      author: q.author,
      cover: q.cover,
      duration: q.duration,
    }));
}

function snapshot() {
  const s = store.get();
  const p = s.playing;
  return {
    queue: slimQueue(s.queue),
    currentIndex: Number.isInteger(s.currentIndex) ? s.currentIndex : -1,
    playing: p && p.bvid
      ? {
          key: p.key,
          bvid: p.bvid,
          cid: p.cid,
          title: p.title,
          author: p.author,
          cover: p.cover,
          duration: p.duration,
        }
      : null,
    position: Math.max(0, Math.floor(s.currentTime || 0)),
    updatedAt: Date.now(),
  };
}

function structSig(s) {
  const keys = (s.queue || []).map((q) => `${q.bvid}_${q.cid}`).join('|');
  return `${keys}#${s.currentIndex}#${s.playing?.bvid || ''}#${s.playing?.cid || ''}`;
}

function write(sync = false) {
  const session = snapshot();
  const hasContent = session.queue.length > 0 || !!session.playing;
  // 从没听过东西就不要写：避免空快照把上次的播放现场冲掉
  if (!hasContent && !everHadContent) return;
  if (hasContent) everHadContent = true;
  lastSavedAt = Date.now();
  if (sync) {
    try {
      bili.setConfigSync({ session });
    } catch {}
    return;
  }
  bili.setConfig({ session }).catch(() => {});
}

function scheduleStruct() {
  if (structTimer) return;
  structTimer = setTimeout(() => {
    structTimer = null;
    write();
  }, STRUCT_DELAY);
}

function schedulePos() {
  if (posTimer) return;
  posTimer = setTimeout(() => {
    posTimer = null;
    write();
  }, POS_DELAY);
}

/** 启动时调用一次：订阅 store，把变化写回主进程 */
export function initSessionPersistence() {
  const s0 = store.get();
  everHadContent = (s0.queue || []).length > 0 || !!s0.playing;
  lastStructSig = structSig(s0);
  store.subscribe((s) => {
    const sig = structSig(s);
    if (sig !== lastStructSig) {
      lastStructSig = sig;
      scheduleStruct();
    }
    if (s.isPlaying && s.currentTime > 0) schedulePos();
  });

  // 关窗 / 刷新 / 托盘退出都会走到这里，同步写一把
  const flushNow = () => {
    if (structTimer) {
      clearTimeout(structTimer);
      structTimer = null;
    }
    if (posTimer) {
      clearTimeout(posTimer);
      posTimer = null;
    }
    write(true);
  };
  window.addEventListener('beforeunload', flushNow);
  window.addEventListener('pagehide', flushNow);
  return flushNow;
}

export function currentSession() {
  return snapshot();
}

export function lastSaveTime() {
  return lastSavedAt;
}
