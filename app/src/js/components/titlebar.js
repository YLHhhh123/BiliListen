// ===== titlebar.js：自绘标题栏 =====

import { el, svg } from '../utils.js';
import { bili } from '../api.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { toast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const ICONS = {
  search: 'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  minimize: 'M6 19h12v2H6z',
  maximize: 'M4 4h16v16H4V4zm2 2v12h12V6H6z',
  restore: 'M5 5v14h14V5H5zm2 2h10v10H7V7z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
};

/** 判断输入是否是 BV号/链接，是则走 resolve，否则走搜索 */
function isBvInput(v) {
  const s = v.trim();
  if (!s) return false;
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return true;
  if (/^av\d+$/i.test(s)) return true;
  if (/^\d+$/.test(s) && s.length > 5) return true; // aid
  if (s.includes('bilibili.com/video')) return true;
  if (s.includes('b23.tv')) return true;
  return false;
}

export function mountTitlebar() {
  const root = document.getElementById('titlebar');
  root.innerHTML = '';

  const logoImg = el('img', { src: './assets/logo.svg', alt: '' });
  const logo = el('div', { class: 'titlebar-logo' }, [logoImg, el('span', {}, 'BiliListen')]);

  const searchInput = el('input', {
    type: 'text',
    placeholder: '搜索视频 / 粘贴 BV号 或 链接 直接播放',
  });
  const searchBox = el('div', { class: 'titlebar-search' }, [
    svg(ICONS.search, { size: 16, fill: 'var(--text-3)' }),
    searchInput,
  ]);

  searchInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const kw = searchInput.value.trim();
    if (!kw) return;
    if (isBvInput(kw)) {
      const res = await bili.resolve({ input: kw });
      if (!res.ok) { toast.error(res.error || '解析失败'); return; }
      if (res.data.type === 'ogv') { toast.info('番剧暂不支持'); return; }
      // 直接播放
      const { playVideo } = await import('../player.js');
      playVideo({ bvid: res.data.bvid, cid: 0, title: res.data.bvid });
      // 跳转到搜索页展示
      navigate('search', { keyword: kw, direct: true });
    } else {
      navigate('search', { keyword: kw });
    }
  });

  const minBtn = el('div', { class: 'win-btn', title: '最小化', onclick: () => bili.minimize() },
    [svg(ICONS.minimize, { size: 14 })]);
  const maxBtn = el('div', { class: 'win-btn', title: '最大化', onclick: () => bili.maximize() },
    [svg(ICONS.maximize, { size: 14 })]);
  const closeBtn = el('div', { class: 'win-btn close', title: '关闭', onclick: () => bili.close() },
    [svg(ICONS.close, { size: 14 })]);

  const actions = el('div', { class: 'titlebar-actions' }, [minBtn, maxBtn, closeBtn]);

  root.append(logo, searchBox, actions);

  // 监听最大化状态切换图标
  refreshMaxIcon(maxBtn);
  setInterval(() => refreshMaxIcon(maxBtn), 1500);
}

let lastMaxState = null;
async function refreshMaxIcon(btn) {
  try {
    const max = await bili.isMaximized();
    if (max === lastMaxState) return;
    lastMaxState = max;
    btn.innerHTML = '';
    btn.appendChild(svg(max ? ICONS.restore : ICONS.maximize, { size: 14 }));
  } catch {}
}

/** 设置搜索框内容（从侧边栏搜索触发时） */
export function setSearchKeyword(kw) {
  const input = document.querySelector('.titlebar-search input');
  if (input) input.value = kw;
}
