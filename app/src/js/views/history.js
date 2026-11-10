// ===== views/history.js：最近在听 =====
// Tab1 本机（localStorage，播放器写入）；Tab2 云端（B 站历史，需登录）

import { bili } from '../api.js';
import { playHistory, store } from '../store.js';
import { el, fmtDuration, fmtPlay, fmtTime } from '../utils.js';
import { playVideo } from '../player.js';
import { toast } from '../components/toast.js';

let root = null;
let tab = 'local'; // local | cloud
let cloudItems = [];
let cloudLoaded = false;

export async function mount(container) {
  root = el('div', { class: 'view-history' });
  container.appendChild(root);
  tab = 'local';
  cloudLoaded = false;
  render();
}

export function unmount() {
  root = null;
}

function render() {
  if (!root) return;
  root.innerHTML = '';

  root.appendChild(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title', text: '最近在听' }),
      el('div', { class: 'page-subtitle', text: '本机播放记录与 B 站云端历史' }),
    ]),
  );

  // Tab 切换
  const tabs = el('div', { class: 'seg-tabs' });
  [
    { key: 'local', label: '本机' },
    { key: 'cloud', label: '云端' },
  ].forEach((t) => {
    tabs.appendChild(
      el('button', {
        class: 'seg-tab' + (tab === t.key ? ' active' : ''),
        text: t.label,
        onclick: () => {
          if (tab === t.key) return;
          tab = t.key;
          render();
        },
      }),
    );
  });
  root.appendChild(tabs);

  const body = el('div', { class: 'history-body' });
  root.appendChild(body);

  if (tab === 'local') renderLocal(body);
  else renderCloud(body);
}

function renderLocal(box) {
  const list = playHistory.get();
  if (!list.length) {
    box.appendChild(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'title', text: '还没有播放记录' }),
        el('div', { class: 'desc', text: '去发现页点一首开始听吧' }),
      ]),
    );
    return;
  }

  const wrap = el('div', { class: 'history-list' });
  list.forEach((it) => {
    wrap.appendChild(historyRow(it, () => playVideo(it, { startAt: it.lastPos || it.progress || 0 })));
  });
  box.appendChild(wrap);

  box.appendChild(
    el('div', { class: 'history-actions' }, [
      el('button', {
        class: 'btn ghost',
        text: '清空本机记录',
        onclick: () => {
          playHistory.clear();
          render();
        },
      }),
    ]),
  );
}

async function renderCloud(box) {
  if (!cloudLoaded) {
    box.appendChild(el('div', { class: 'loading-mask' }, [el('div', { class: 'spinner' })]));
    const res = await bili.history({ page: 1, pageSize: 40 });
    cloudLoaded = true;
    if (!res.ok) {
      box.innerHTML = '';
      box.appendChild(
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'title', text: '需要登录' }),
          el('div', { class: 'desc', text: res.error || '登录后可查看云端播放历史' }),
        ]),
      );
      return;
    }
    cloudItems = res.data.items || [];
    if (!root) return;
    render();
    return;
  }

  if (!cloudItems.length) {
    box.appendChild(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'title', text: '云端暂无记录' }),
        el('div', { class: 'desc', text: '在 B 站 App 或网页看过的视频会出现在这里' }),
      ]),
    );
    return;
  }

  const wrap = el('div', { class: 'history-list' });
  cloudItems.forEach((it) => {
    wrap.appendChild(historyRow(it, () => playVideo(it, { startAt: it.lastPos || it.progress || 0 })));
  });
  box.appendChild(wrap);
}

function historyRow(it, onPlay) {
  const progress =
    it.duration && it.lastPos ? Math.min(1, it.lastPos / it.duration) : it.progress && it.duration ? Math.min(1, it.progress / it.duration) : 0;

  const cover = el('div', { class: 'cover' }, [el('span', { class: 'duration', text: fmtDuration(it.duration) })]);
  if (it.cover) {
    bili.img(it.cover).then((res) => {
      const u = res && res.ok && res.data ? res.data.url : it.cover;
      cover.style.backgroundImage = 'url("' + u + '")';
    }).catch(() => { cover.style.backgroundImage = 'url("' + it.cover + '")'; });
  }

  const info = el('div', { class: 'info' }, [
    el('div', { class: 't', text: it.title || '' }),
    el('div', { class: 's', text: [it.author, fmtPlay(it.play) + '播放', fmtTime(it.updatedAt || it.pubdate)].filter(Boolean).join(' · ') }),
  ]);

  if (progress > 0) {
    info.appendChild(el('div', { class: 'prog' }, [el('span', { style: { width: (progress * 100).toFixed(1) + '%' } })]));
  }

  const row = el('div', { class: 'history-item', onclick: onPlay }, [cover, info]);

  row.appendChild(
    el('button', {
      class: 'icon-btn del',
      text: '×',
      title: '移除记录',
      onclick: (e) => {
        e.stopPropagation();
        if (tab === 'local') {
          playHistory.remove(it.bvid, it.cid);
          render();
        } else {
          toast.info('云端记录请到 B 站 App 删除');
        }
      },
    }),
  );

  return row;
}
