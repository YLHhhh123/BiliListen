// ===== views/search.js：搜索页 =====
// 排序切换 + 结果网格 + 搜索历史（localStorage）

import { bili } from '../api.js';
import { searchHistory } from '../store.js';
import { el, fmtDuration, fmtPlay, fmtTime } from '../utils.js';
import { createCard, createSkeletonCard } from '../components/card.js';

const ORDERS = [
  { key: '', label: '综合' },
  { key: 'click', label: '最多播放' },
  { key: 'pubdate', label: '最新发布' },
];

let root = null;
let grid = null;
let sentinel = null;
let observer = null;
let reqSeq = 0;

const state = {
  keyword: '',
  order: '',
  page: 1,
  loading: false,
  noMore: false,
};

export async function mount(container, params = {}) {
  root = el('div', { class: 'view-search' });
  container.appendChild(root);

  state.keyword = (params.keyword || '').trim();
  state.order = '';
  state.page = 1;
  state.loading = false;
  state.noMore = false;

  renderShell();
  if (state.keyword) {
    loadPage(true);
  } else {
    renderHistoryPanel();
  }
}

export function unmount() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  reqSeq++;
  root = null;
  grid = null;
  sentinel = null;
}

function renderShell() {
  root.innerHTML = '';

  root.appendChild(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title', text: '搜索' }),
      el(
        'div',
        { class: 'page-subtitle' },
        state.keyword ? `“${state.keyword}” 的搜索结果` : '在标题栏输入关键词后回车，支持 BV 号直达',
      ),
    ]),
  );

  // 排序 chip
  const bar = el('div', { class: 'search-orders' });
  ORDERS.forEach((o) => {
    bar.appendChild(
      el('button', {
        class: 'search-order' + (state.order === o.key ? ' active' : ''),
        text: o.label,
        onclick: () => {
          if (state.order === o.key) return;
          state.order = o.key;
          [...bar.children].forEach((c) => c.classList.remove('active'));
          bar.children[ORDERS.indexOf(o)].classList.add('active');
          if (state.keyword) loadPage(true);
        },
      }),
    );
  });
  root.appendChild(bar);

  grid = el('div', { class: 'card-grid' });
  root.appendChild(grid);

  sentinel = el('div', { class: 'scroll-sentinel' });
  root.appendChild(sentinel);

  attachObserver();
}

function attachObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && state.keyword && !state.loading && !state.noMore) {
        loadPage(false);
      }
    },
    { rootMargin: '320px' },
  );
  observer.observe(sentinel);
}

function showSkeletons(n = 10) {
  if (!grid) return;
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) grid.appendChild(createSkeletonCard());
}

async function loadPage(reset) {
  if (state.loading) return;
  state.loading = true;
  const seq = ++reqSeq;

  if (reset) {
    state.page = 1;
    state.noMore = false;
    showSkeletons();
  }

  try {
    const res = await bili.search({
      keyword: state.keyword,
      page: state.page,
      pageSize: 20,
      order: state.order,
    });
    if (seq !== reqSeq || !grid) return;

    if (!res.ok) {
      if (reset) showEmpty('搜索失败', res.error || '请稍后重试');
      state.noMore = true;
      return;
    }

    const data = res.data;
    if (reset) {
      grid.innerHTML = '';
      searchHistory.add(state.keyword);
      if (!data.items.length) {
        showEmpty('没有找到相关视频', '换个关键词试试');
        state.noMore = true;
        return;
      }
    }

    data.items.forEach((item) => {
      grid.appendChild(createCard(item));
    });

    state.page += 1;
    if (data.items.length < (data.pageSize || 20)) state.noMore = true;
  } finally {
    if (seq === reqSeq) state.loading = false;
  }
}

function showEmpty(title, desc) {
  if (!grid) return;
  grid.innerHTML = '';
  grid.appendChild(
    el('div', { class: 'empty-state' }, [
      el('div', { class: 'title', text: title }),
      el('div', { class: 'desc', text: desc || '' }),
    ]),
  );
}

function renderHistoryPanel() {
  if (!grid) return;
  grid.innerHTML = '';

  const list = searchHistory.get();
  if (!list.length) {
    grid.appendChild(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'title', text: '还没有搜索记录' }),
        el('div', { class: 'desc', text: '试试搜索「音乐」「周杰伦」「纯音乐」' }),
      ]),
    );
    return;
  }

  const wrap = el('div', { class: 'search-history-block' }, [
    el('div', { class: 'search-history-head' }, [
      el('span', { text: '搜索历史' }),
      el('button', {
        class: 'link-btn',
        text: '清空',
        onclick: () => {
          searchHistory.clear();
          renderHistoryPanel();
        },
      }),
    ]),
  ]);

  const tags = el('div', { class: 'history-tags' });
  list.forEach((kw) => {
    const tag = el('div', {
      class: 'history-tag',
      onclick: () => {
        state.keyword = kw;
        renderShell();
        loadPage(true);
      },
    }, [el('span', { text: kw }), el('span', { class: 'x', text: '×' })]);
    // 点 × 单独删除
    tag.lastChild.addEventListener('click', (e) => {
      e.stopPropagation();
      searchHistory.remove(kw);
      renderHistoryPanel();
    });
    tags.appendChild(tag);
  });
  wrap.appendChild(tags);
  grid.appendChild(wrap);
}
