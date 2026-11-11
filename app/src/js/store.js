// ===== store.js：全局状态（发布订阅）+ localStorage 缓存 =====

/** 创建极简 store：get / set / subscribe */
export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  const get = () => state;

  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => {
      try { fn(state); } catch (e) { console.error('[store listener]', e); }
    });
    return state;
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { get, set, subscribe };
}

// ---------- localStorage 工具 ----------
const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

export const storage = LS;

// 搜索历史（最多 10 条）
const SEARCH_HISTORY_KEY = 'bl_search_history';
export const searchHistory = {
  get() { return LS.get(SEARCH_HISTORY_KEY, []); },
  add(kw) {
    if (!kw) return;
    const list = LS.get(SEARCH_HISTORY_KEY, []).filter((k) => k !== kw);
    list.unshift(kw);
    LS.set(SEARCH_HISTORY_KEY, list.slice(0, 10));
  },
  remove(kw) {
    const list = LS.get(SEARCH_HISTORY_KEY, []).filter((k) => k !== kw);
    LS.set(SEARCH_HISTORY_KEY, list);
  },
  clear() { LS.del(SEARCH_HISTORY_KEY); },
};

// 本地播放历史（最多 200 条）
const HISTORY_KEY = 'bl_history';
export const playHistory = {
  get() { return LS.get(HISTORY_KEY, []); },
  /** 更新或新增一条；lastPos 由 timeupdate 写入 */
  upsert(item) {
    const list = LS.get(HISTORY_KEY, []);
    const idx = list.findIndex((x) => x.bvid === item.bvid && x.cid === item.cid);
    const rec = { ...(idx >= 0 ? list[idx] : {}), ...item, updatedAt: Date.now() };
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(rec);
    LS.set(HISTORY_KEY, list.slice(0, 200));
  },
  remove(bvid, cid) {
    const list = LS.get(HISTORY_KEY, []).filter((x) => !(x.bvid === bvid && x.cid === cid));
    LS.set(HISTORY_KEY, list);
  },
  clear() { LS.del(HISTORY_KEY); },
};

// 全局 store
export const store = createStore({
  config: null,            // bili.getAllConfig 结果
  user: null,              // 登录用户信息
  playing: null,           // 当前播放：{bvid,cid,title,author,cover,duration,...}
  queue: [],               // 播放队列 [{key,bvid,cid,title,author,cover,duration}]
  currentIndex: -1,        // 当前播放在队列中的索引
  isPlaying: false,
  progress: 0,             // 0-1
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  rate: 1.0,
  playMode: 'order',       // order | loop | single | shuffle
  buffering: false,
  queueOpen: false,
  nowPlayingOpen: false,
  theme: 'dark',
  sleepTimer: 0,           // 目标时间戳 ms，0=未开启
  sleepRemaining: 0,       // 剩余秒数
  pauseAfterCurrent: false, // 播完当前曲目暂停；内存态，重启自动清空
  lyrics: [],              // 当前字幕 lines
});
