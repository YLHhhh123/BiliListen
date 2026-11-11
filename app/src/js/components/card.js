// ===== card.js：视频卡片 =====

import { el, svg, fmtDuration, fmtPlay, fmtTime } from '../utils.js';
import { bili } from '../api.js';
import { toast } from './toast.js';
import { playVideo, addToQueue } from '../player.js';
import { generatePlaylist } from '../playlist.js';

const ICONS = {
  play: 'M8 5v14l11-7z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
};

/** 创建一个视频卡片；item: VideoItem */
export function createCard(item) {
  const card = el('div', {
    class: 'video-card',
    dataset: { bvid: item.bvid },
  });

  const cover = el('div', { class: 'card-cover' });
  if (item.cover) {
    // B 站封面 CDN 校验 Referer，<img> 直连拿不到图，统一走本地图片代理
    const img = el('img', {
      src: item.cover,
      loading: 'lazy',
      alt: item.title || '',
      onerror: (e) => {
        const imgEl = e.target;
        if (!imgEl.dataset.retried) {
          imgEl.dataset.retried = '1';
          bili.img(item.cover).then((res) => {
            if (res && res.ok && res.data?.url) imgEl.src = res.data.url;
            else fallback();
          }).catch(fallback);
        } else {
          fallback();
        }
        function fallback() {
          imgEl.style.display = 'none';
          cover.style.background = 'linear-gradient(135deg, var(--bg-3), var(--bg-4))';
        }
      },
    });
    // 直接用代理 URL，不等 onerror（B 站图片对无 Referer 请求返回 403 但不触发 onerror 的时机不稳定）
    bili.img(item.cover).then((res) => {
      if (res && res.ok && res.data?.url) img.src = res.data.url;
    }).catch(() => {});
    cover.appendChild(img);
  } else {
    cover.style.background = 'linear-gradient(135deg, var(--bg-3), var(--bg-4))';
  }

  cover.appendChild(el('div', { class: 'play-btn' }, [svg(ICONS.play, { size: 20, fill: '#fff' })]));
  if (item.duration) {
    cover.appendChild(el('span', { class: 'duration' }, fmtDuration(item.duration)));
  }
  cover.appendChild(el('div', {
    class: 'more-btn',
    onclick: (e) => { e.stopPropagation(); openCardMenu(e, item); },
  }, [svg(ICONS.more, { size: 14, fill: '#fff' })]));

  const body = el('div', { class: 'card-body' }, [
    el('div', { class: 'card-title' }, item.title || ''),
    el('div', { class: 'card-meta' }, [
      el('span', {}, item.author || ''),
      el('span', { class: 'dot' }, '·'),
      el('span', {}, fmtPlay(item.play) + '播放'),
      el('span', { class: 'dot' }, '·'),
      el('span', {}, fmtTime(item.pubdate)),
    ]),
  ]);

  card.append(cover, body);

  // 整卡点击 = 播放
  card.addEventListener('click', () => handlePlay(item));

  // 拖拽到播放条 = 加入队列
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/json', JSON.stringify(item));
  });

  return card;
}

/** 播放处理：如果是分P视频，展开所有分P到队列 */
async function handlePlay(item) {
  try {
    const v = await bili.video({ bvid: item.bvid });
    if (!v.ok) { toast.error(v.error || '获取视频信息失败'); return; }
    const pages = v.data.pages || [{ cid: v.data.cid, page: 1, part: '', duration: v.data.duration }];
    const baseTitle = v.data.title || item.title || item.bvid;
    const author = v.data.owner?.name || item.author || '';
    const cover = v.data.cover || item.cover;

    if (pages.length <= 1) {
      playVideo({
        bvid: item.bvid, cid: pages[0].cid,
        title: baseTitle, author, cover, duration: pages[0].duration || v.data.duration,
      });
    } else {
      // 多分P：展开到队列
      const { store } = await import('../store.js');
      const queue = [];
      pages.forEach((p, i) => {
        queue.push({
          key: `${item.bvid}_${p.cid}`,
          bvid: item.bvid, cid: p.cid,
          title: `${baseTitle} - P${p.page || i + 1} ${p.part || ''}`.trim(),
          author, cover, duration: p.duration,
        });
      });
      store.set({ queue, currentIndex: 0 });
      playVideo(queue[0]);
    }
  } catch (e) {
    console.error(e);
    toast.error('加载视频失败');
  }
}

/** 卡片右键菜单（⋯） */
function openCardMenu(e, item) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = el('div', { class: 'context-menu' });
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const items = [
    { label: '加入队列', action: () => addToQueue(item) },
    { label: '稍后播放', action: () => addToQueue(item) },
    // 以这个视频为种子拉相关推荐，自动组成一条连续的播放目录
    { label: '以此生成播放目录', action: () => generatePlaylist('related', { seedBvid: item.bvid }) },
    { label: '在浏览器打开', action: () => bili.openExternal(`https://www.bilibili.com/video/${item.bvid}`) },
  ];
  items.forEach((it) => {
    menu.appendChild(el('div', {
      class: 'item',
      onclick: () => { it.action(); menu.remove(); },
    }, it.label));
  });
  document.body.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/** 骨架屏卡片 */
export function createSkeletonCard() {
  const card = el('div', { class: 'video-card skeleton-card' });
  const cover = el('div', { class: 'card-cover' }, [el('div', { class: 'skeleton sk-cover' })]);
  const body = el('div', { class: 'card-body' }, [
    el('div', { class: 'skeleton sk-line' }),
    el('div', { class: 'skeleton sk-line short' }),
  ]);
  card.append(cover, body);
  return card;
}
