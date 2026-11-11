// ===== playlist.js：自动生成播放目录 =====
// 「播放目录」= 从热门、榜单、最近在听、收藏或相关推荐中批量生成连续播放队列。

import { el } from './utils.js';
import { bili } from './api.js';
import { store, playHistory } from './store.js';
import { playVideo, addToQueue } from './player.js';
import { openModal, closeModal } from './components/modal.js';
import { toast } from './components/toast.js';

const MAX_ITEMS = 50;
const COUNT_OPTIONS = [10, 20, 30, 50];

function playlistLimit(value) {
  const n = Math.floor(Number(value) || 30);
  return Math.max(1, Math.min(MAX_ITEMS, n));
}

function normalizeItem(value) {
  const v = value?.item || value;
  if (!v?.bvid) return null;
  return {
    key: `${v.bvid}_${v.cid || 0}`,
    bvid: v.bvid,
    cid: v.cid || undefined,
    title: v.title || '',
    author: v.author || v.owner?.name || v.upper?.name || '',
    cover: v.cover || v.pic || '',
    duration: Number(v.duration) || 0,
  };
}

function normalizeItems(items, limit) {
  const result = [];
  const seen = new Set();
  for (const value of items || []) {
    const item = normalizeItem(value);
    if (!item || seen.has(item.bvid)) continue;
    seen.add(item.bvid);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

async function fetchSourceItems(source, opts, limit) {
  const pageSize = Math.max(30, limit);

  if (source === 'popular') {
    const res = await bili.popular({ page: 1, pageSize });
    if (!res.ok) throw new Error(res.error || '读取热门内容失败');
    return res.data.items || [];
  }

  if (source === 'ranking') {
    const res = await bili.ranking({ rid: opts.rid ?? 3, pageSize });
    if (!res.ok) throw new Error(res.error || '读取排行榜失败');
    return res.data.items || [];
  }

  if (source === 'history') {
    const local = playHistory.get();
    let cloud = [];
    if (local.length < limit && store.get().user?.isLogin) {
      const res = await bili.history({ page: 1, pageSize });
      if (res.ok) cloud = res.data.items || [];
    }
    return [...local, ...cloud];
  }

  if (source === 'related') {
    if (!opts.seedBvid) throw new Error('缺少种子视频');
    const res = await bili.related({ bvid: opts.seedBvid, pageSize });
    if (!res.ok) throw new Error(res.error || '读取相关推荐失败');
    // 种子本身放队首；normalizeItems 会自动去掉相关推荐里可能重复的种子。
    return [{ bvid: opts.seedBvid }, ...(res.data.items || [])];
  }

  if (source === 'fav') {
    if (!store.get().user?.isLogin) throw new Error('请先登录 B 站账号，再生成收藏目录');
    let mediaId = opts.mediaId;
    if (!mediaId) {
      const folders = await bili.favFolders({});
      if (!folders.ok) throw new Error(folders.error || '读取收藏夹失败');
      const first = (folders.data.folders || [])[0];
      if (!first) throw new Error('未找到收藏夹，请先收藏一些视频');
      mediaId = first.id;
    }
    const res = await bili.favList({ mediaId, page: 1, pageSize: limit });
    if (!res.ok) throw new Error(res.error || '读取收藏内容失败');
    return res.data.items || [];
  }

  throw new Error(`未知播放目录来源：${source}`);
}

/**
 * 生成播放目录并立即播放。
 * @param {'popular'|'ranking'|'history'|'related'|'fav'} source
 * @param {{seedBvid?: string, rid?: number, mediaId?: number, limit?: number}} opts
 * @returns {Promise<number>} 入队条数（0 = 失败或没有可播内容）
 */
export async function generatePlaylist(source, opts = {}) {
  const limit = playlistLimit(opts.limit);
  let queue;
  try {
    const rawItems = await fetchSourceItems(source, opts, limit);
    queue = normalizeItems(rawItems, limit);
  } catch (e) {
    toast.error('生成播放目录失败：' + (e.message || e));
    return 0;
  }

  if (!queue.length) {
    const message = source === 'history'
      ? '最近还没有播放记录，先听几首再生成目录'
      : '没有可播放的内容';
    toast.error(message);
    return 0;
  }

  // cid 可以先留空；playVideo 会按需解析，并把解析结果回写到当前队列项。
  store.set({ queue, currentIndex: 0 });
  await playVideo(queue[0]);
  toast.success(`已生成播放目录（${queue.length} 条），开始播放`);
  return queue.length;
}

/** 加入队列但不打断当前播放。 */
export function appendToPlaylist(items) {
  const list = normalizeItems(items, MAX_ITEMS);
  list.forEach((item) => addToQueue(item));
  return list.length;
}

/** 侧边栏「自动目录」入口：选择来源和条数。 */
export function openPlaylistGenModal() {
  const countSelect = el('select', { class: 'btn playlist-count-select', title: '生成数量' },
    COUNT_OPTIONS.map((n) => el('option', { value: n }, `${n} 条`)));
  countSelect.value = '30';

  const run = async (source, opts = {}) => {
    const limit = Number(countSelect.value) || 30;
    closeModal();
    openGenerating();
    try {
      await generatePlaylist(source, { ...opts, limit });
    } finally {
      closeModal();
    }
  };

  const card = (title, desc, onclick) => el('button', {
    class: 'playlist-gen-card',
    onclick,
  }, [
    el('div', { class: 't' }, title),
    el('div', { class: 'd' }, desc),
  ]);

  const grid = el('div', { class: 'playlist-gen-grid' }, [
    card('综合热门', '全站热门内容，无需登录', () => run('popular')),
    card('音乐排行榜', '音乐区排行榜，无需登录', () => run('ranking', { rid: 3 })),
    card('最近在听', '优先本机记录，登录后补充云端历史', () => run('history')),
    card('我的收藏', '默认取第一个收藏夹，需登录', () => run('fav')),
  ]);

  openModal({
    title: '自动生成播放目录',
    body: el('div', {}, [
      el('p', { class: 'playlist-gen-hint' },
        '选择内容来源和生成数量。生成后会替换当前队列，并从第一条开始播放。'),
      el('label', { class: 'playlist-count-row' }, [
        el('span', {}, '生成数量'),
        countSelect,
      ]),
      grid,
    ]),
  });
}

function openGenerating() {
  openModal({
    title: '生成中',
    body: el('div', { class: 'playlist-gen-loading' }, [
      el('div', { class: 'spin' }),
      el('span', {}, '正在生成播放目录…'),
    ]),
  });
}
