// ===== queue.js：播放队列抽屉（右侧滑入，拖拽排序） =====

import { el, svg, fmtDuration } from '../utils.js';
import { bili } from '../api.js';
import { store } from '../store.js';
import { playQueueIndex, removeFromQueue, clearQueue, reorderQueue } from '../player.js';
import { openPlaylistGenModal } from '../playlist.js';

const ICONS = {
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  del: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
};

let els = null; // { mask, panel, list }
let unsub = null;

export function mountQueue() {
  const root = document.getElementById('queue-root');
  if (!root) return;
  root.innerHTML = '';

  const mask = el('div', { class: 'queue-mask' });
  const panel = el('div', { class: 'queue-panel' });
  const header = el('div', { class: 'queue-header' }, [
    el('h3', {}, '播放队列'),
    el('div', { class: 'queue-actions' }, [
      // 空队列的快捷入口：不想去翻页面时直接在这里生成一批
      el('span', { class: 'link', title: '自动生成一批可听内容', onclick: openPlaylistGenModal }, '自动目录'),
      el('span', { class: 'link', onclick: () => { clearQueue(); toastClear(); } }, '清空'),
      el('span', { class: 'link', title: '关闭', onclick: () => store.set({ queueOpen: false }) },
        [svg(ICONS.close, { size: 14 })]),
    ]),
  ]);
  const list = el('div', { class: 'queue-list' });

  panel.append(header, list);
  root.append(mask, panel);

  mask.addEventListener('click', () => store.set({ queueOpen: false }));

  els = { mask, panel, list };
  if (unsub) unsub();
  unsub = store.subscribe(render);
  render(store.get());
}

function toastClear() {
  import('./toast.js').then(({ toast }) => toast.success('队列已清空'));
}

function render(s) {
  if (!els) return;
  const open = !!s.queueOpen;
  els.mask.classList.toggle('open', open);
  els.panel.classList.toggle('open', open);
  els.panel.style.pointerEvents = open ? 'auto' : 'none';

  els.list.innerHTML = '';
  if (!s.queue || s.queue.length === 0) {
    els.list.appendChild(el('div', { class: 'empty-state', style: { padding: '60px 20px' } }, [
      el('div', { style: { fontSize: 48, color: 'var(--bg-4)', textAlign: 'center', marginBottom: 16 } }, '♪'),
      el('div', { class: 'title' }, '队列为空'),
      el('div', { class: 'desc' }, '点右上「自动目录」一键生成，或从视频卡片拖到播放条加入'),
    ]));
    return;
  }

  s.queue.forEach((item, i) => {
    const thumb = el('div', { class: 'thumb' });
    if (item.cover) {
      bili.img(item.cover).then((res) => {
        if (res && res.ok && res.data && res.data.url) {
          thumb.style.backgroundImage = 'url("' + res.data.url + '")';
        }
      }).catch(() => {});
    }

    const row = el('div', {
      class: 'queue-item' + (i === s.currentIndex ? ' playing' : ''),
      draggable: true,
      dataset: { idx: i },
    }, [
      el('span', { class: 'idx' }, String(i + 1)),
      thumb,
      el('div', { class: 'info' }, [
        el('div', { class: 't clamp-1' }, item.title || item.bvid),
        el('div', { class: 'a clamp-1' },
          (item.author || '') + (item.duration ? ` · ${fmtDuration(item.duration)}` : '')),
      ]),
      el('div', { class: 'del', title: '移除', onclick: (e) => { e.stopPropagation(); removeFromQueue(i); } },
        [svg(ICONS.del, { size: 14 })]),
    ]);

    row.addEventListener('click', () => playQueueIndex(i));

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const rect = row.getBoundingClientRect();
      const pos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
      if (!isNaN(from)) reorderQueue(from, i, pos);
    });

    els.list.appendChild(row);
  });
}
