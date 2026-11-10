// ===== ranking.js：排行榜（音乐/全站/游戏/科技/生活，列表形态） =====

import { el, fmtDuration } from '../utils.js';
import { bili } from '../api.js';
import { toast } from '../components/toast.js';
import { playVideo } from '../player.js';

const TABS = [
  { key: '3', label: '音乐' },
  { key: '0', label: '全站' },
  { key: '4', label: '游戏' },
  { key: '36', label: '科技' },
  { key: '160', label: '生活' },
];

let observer = null;

function reset() {
  if (observer) { observer.disconnect(); observer = null; }
}

export function mount(container) {
  reset();
  store_set_route('ranking');

  let currentTab = '3';

  const list = el('div', { class: 'rank-list' });

  // 拉某区榜单
  async function load(rid) {
    list.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      list.appendChild(el('div', { class: 'rank-item' }, [
        el('div', { class: 'rank-num' }, [el('div', { class: 'skeleton', style: { width: 20, height: 22 } })]),
        el('div', { class: 'rank-info' }, [
          el('div', { class: 'rank-title' }, [el('div', { class: 'skeleton', style: { width: '70%', height: 14 } })]),
          el('div', { class: 'rank-sub' }, [el('div', { class: 'skeleton', style: { width: '40%', height: 11 } })]),
        ]),
      ]));
    }
    const res = await bili.ranking({ rid: Number(rid), pageSize: 30 });
    if (!list.isConnected) return; // 已切走
    list.innerHTML = '';
    if (!res.ok) { toast.error(res.error || '加载排行榜失败'); return; }
    const items = res.data.items || [];
    if (items.length === 0) {
      list.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'title' }, '暂无数据'),
      ]));
      return;
    }
    items.forEach((item, i) => {
      const rank = i + 1;
      const numCls = 'rank-num' + (rank <= 3 ? ` top${rank}` : '');
      const row = el('div', { class: 'rank-item' }, [
        el('div', { class: numCls }, String(rank)),
        el('div', { class: 'rank-info' }, [
          el('div', { class: 'rank-title clamp-1' }, item.title || item.bvid),
          el('div', { class: 'rank-sub clamp-1' }, item.author || ''),
        ]),
        el('div', { class: 'rank-duration' }, fmtDuration(item.duration)),
      ]);
      // 整行点击播放
      row.addEventListener('click', () => {
        playVideo({ bvid: item.bvid, cid: item.cid, title: item.title, author: item.author, cover: item.cover, duration: item.duration });
      });
      list.appendChild(row);
    });
  }

  const tabsEl = el('div', { class: 'tabs' });
  TABS.forEach((t) => {
    tabsEl.appendChild(el('div', {
      class: 'tab' + (t.key === currentTab ? ' active' : ''),
      dataset: { rid: t.key },
      onclick: () => {
        currentTab = t.key;
        tabsEl.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.rid === currentTab));
        load(currentTab);
      },
    }, t.label));
  });

  container.append(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, '排行榜'),
      el('div', { class: 'page-subtitle' }, '各分区热门榜单'),
    ]),
    tabsEl,
    list,
  );

  load(currentTab);
}

export function unmount() {
  reset();
}

function store_set_route(name) {
  import('../store.js').then(({ store }) => store.set({ currentRoute: name }));
}
