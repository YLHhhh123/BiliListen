// ===== discover.js：发现页（推荐 / 热门，无限滚动） =====

import { el } from '../utils.js';
import { bili } from '../api.js';
import { toast } from '../components/toast.js';
import { createCard, createSkeletonCard } from '../components/card.js';

const state = {
  tab: 'popular',      // popular = 推荐(popular接口) | hot = 热门(ranking rid 0)
  page: 1,
  noMore: false,
  loading: false,      // 防重入
  observer: null,
};

/** 清理本页状态（unmount 时调用） */
function reset() {
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  state.page = 1;
  state.noMore = false;
  state.loading = false;
  state.tab = 'popular';
}

/** 清掉骨架卡与空状态占位（首屏 / 切 Tab 铺的灰块，第一页数据到达时调用） */
function clearSkeletons(grid) {
  grid.querySelectorAll('.skeleton-card, .discover-empty').forEach((n) => n.remove());
}

/** 空状态提示（失败 / 无数据时替换骨架卡，占满整行避免挤占卡片格） */
function showEmpty(grid, msg) {
  clearSkeletons(grid);
  if (grid.querySelector('.discover-empty')) return;
  grid.appendChild(el('div', {
    class: 'discover-empty',
    text: msg,
    style: {
      gridColumn: '1 / -1',
      padding: '48px 0',
      textAlign: 'center',
      color: 'var(--text-3, #888)',
      fontSize: '14px',
    },
  }));
}

/** 拉一页数据 */
async function fetchPage() {
  if (state.loading || state.noMore) return;
  state.loading = true;
  const grid = document.getElementById('discover-grid');
  let res;
  try {
    res = state.tab === 'popular'
      ? await bili.popular({ page: state.page, pageSize: 20 })
      : await bili.ranking({ rid: 0, pageSize: 20 });
  } catch (e) {
    res = { ok: false, error: (e && e.message) || '网络错误' };
  } finally {
    state.loading = false;
  }
  if (!grid) return; // 页面已切走
  if (!res.ok) {
    // 失败：清骨架换空状态，只处理第一页（分页失败不清已有卡片）
    if (state.page === 1) showEmpty(grid, (res.error || '加载失败') + '，滚动可重试');
    toast.error(res.error || '加载失败');
    return;
  }
  const items = res.data.items || [];
  if (items.length === 0) {
    state.noMore = true;
    if (state.page === 1) showEmpty(grid, '暂无内容');
    return;
  }
  // 第一页数据就位：移除骨架卡（切 Tab 后 page 重置为 1，同样会在这里清）
  if (state.page === 1) clearSkeletons(grid);
  // 推荐接口的 noMore 标记；ranking 无此字段，按返回数量判断
  if (res.data.noMore === true || items.length < 10) state.noMore = true;
  items.forEach((it) => grid.appendChild(createCard(it)));
  state.page++;
}

/** 切 Tab：清空网格、重置分页、铺骨架屏、立即拉第一页 */
async function switchTab(tab, grid, tabsEl) {
  state.tab = tab;
  state.page = 1;
  state.noMore = false;
  tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) grid.appendChild(createSkeletonCard());
  await fetchPage();
}

export function mount(container) {
  reset();
  store_set_route('discover');

  const tabsEl = el('div', { class: 'tabs' }, [
    el('div', { class: 'tab active', dataset: { tab: 'popular' }, onclick: () => switchTab('popular', grid, tabsEl) }, '推荐'),
    el('div', { class: 'tab', dataset: { tab: 'hot' }, onclick: () => switchTab('hot', grid, tabsEl) }, '热门'),
  ]);

  const grid = el('div', { class: 'card-grid', id: 'discover-grid' });
  for (let i = 0; i < 12; i++) grid.appendChild(createSkeletonCard());

  // 哨兵元素：进入视口就加载下一页
  const sentinel = el('div', { style: { height: '10px' } });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, '发现'),
      el('div', { class: 'page-subtitle' }, '推荐与热门视频'),
    ]),
    tabsEl,
    grid,
    sentinel,
  );

  // 无限滚动：IntersectionObserver 监听哨兵
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) fetchPage();
  }, { rootMargin: '400px' });
  state.observer.observe(sentinel);

  // 首屏直接拉一页（骨架卡把哨兵挤到视口外，不能只靠 observer 触发）
  fetchPage();
}

export function unmount() {
  reset();
}

function store_set_route(name) {
  // sidebar 高亮依赖这个字段
  import('../store.js').then(({ store }) => store.set({ currentRoute: name }));
}
