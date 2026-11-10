// ===== sidebar.js：侧边导航 =====

import { el, svg } from '../utils.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { bili } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { openLoginModal as openLogin } from './login.js';

const ICONS = {
  discover: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  ranking: 'M7.5 21H2V9h5.5v12zm7.25-18h-5.5v18h5.5V3zM22 11h-5.5v10H22V11z',
  history: 'M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  favorites: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
};

const NAV_ITEMS = [
  { key: 'discover', label: '发现', icon: ICONS.discover },
  { key: 'ranking', label: '排行榜', icon: ICONS.ranking },
  { key: 'history', label: '最近在听', icon: ICONS.history },
  { key: 'favorites', label: '我的收藏', icon: ICONS.favorites },
  { key: 'settings', label: '设置', icon: ICONS.settings },
];

export function mountSidebar() {
  const root = document.getElementById('sidebar');
  root.innerHTML = '';

  const nav = el('div', { class: 'sidebar-nav' });
  NAV_ITEMS.forEach((it) => {
    const item = el('div', {
      class: 'sidebar-item',
      dataset: { key: it.key },
      onclick: () => navigate(it.key),
    }, [svg(it.icon, { size: 18 }), el('span', {}, it.label)]);
    nav.appendChild(item);
  });

  const userBlock = el('div', { class: 'sidebar-user', onclick: onUserClick });
  root.append(nav, userBlock);

  renderUser(userBlock);
  store.subscribe((s) => renderUser(userBlock, s.user));
  store.subscribe((s) => updateActive(nav, s));
}

function renderUser(block, user) {
  const u = user || store.get().user;
  block.innerHTML = '';
  if (u && u.isLogin) {
    const avatar = el('div', {
      class: 'avatar',
      style: { backgroundImage: u.face ? `url(${u.face})` : undefined },
    });
    const meta = el('div', { class: 'meta' }, [
      el('div', { class: 'name clamp-1' }, u.uname || '用户'),
      el('div', { class: 'sub' }, u.vip ? '大会员' : `LV${u.level || 0}`),
    ]);
    block.append(avatar, meta);
  } else {
    const avatar = el('div', { class: 'avatar' });
    const meta = el('div', { class: 'meta' }, [
      el('div', { class: 'name' }, '点击登录'),
      el('div', { class: 'sub' }, '同步收藏与历史'),
    ]);
    block.append(avatar, meta);
  }
}

function updateActive(nav) {
  const cur = store.get().currentRoute || 'discover';
  nav.querySelectorAll('.sidebar-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.key === cur);
  });
}

async function onUserClick() {
  const user = store.get().user;
  if (user && user.isLogin) {
    // 已登录：打开用户菜单
    const body = el('div', {}, [
      el('p', { style: { marginBottom: 12, color: 'var(--text-2)' } }, `已登录：${user.uname}`),
    ]);
    const logoutBtn = el('button', {
      class: 'btn danger',
      onclick: async () => {
        const res = await bili.logout();
        if (res.ok) {
          store.set({ user: null });
          toast.success('已退出登录');
          closeModal();
        }
      },
    }, '退出登录');
    openModal({ title: '账号', body, footer: logoutBtn });
  } else {
    openLoginModal();
  }
}

function openLoginModal() {
  openLogin({ title: '登录 B 站' });
}
