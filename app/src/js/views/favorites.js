// ===== favorites.js：我的收藏 =====
// 未登录 → 引导页 + 登录弹层（网页扫码 / Cookie）；已登录 → 左收藏夹列表 + 右内容网格

import { bili } from '../api.js';
import { store } from '../store.js';
import { el, fmtDuration } from '../utils.js';
import { createCard, createSkeletonCard } from '../components/card.js';
import { openLoginModal } from '../components/login.js';

let root = null;
let folders = [];
let activeFolderId = null;
let foldersLoaded = false;

export async function mount(container) {
  root = el('div', { class: 'view-favorites' });
  container.appendChild(root);
  foldersLoaded = false;
  folders = [];
  activeFolderId = null;
  await render();
}

export function unmount() {
  root = null;
}

async function render() {
  if (!root) return;
  root.innerHTML = '';

  const user = store.get().user;
  if (!user?.isLogin) {
    renderLoginGuide();
    return;
  }

  root.appendChild(
    el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title', text: '我的收藏' }),
      el('div', { class: 'page-subtitle', text: `${user.uname || '已登录'} · ${user.vip ? '大会员' : '普通用户'}` }),
    ]),
  );

  const layout = el('div', { class: 'fav-layout' });
  root.appendChild(layout);

  if (!foldersLoaded) {
    layout.appendChild(el('div', { class: 'loading-mask' }, [el('div', { class: 'spinner' })]));
    const res = await bili.favFolders({});
    foldersLoaded = true;
    if (!root) return;
    if (!res.ok) {
      layout.innerHTML = '';
      layout.appendChild(
        el('div', { class: 'empty-state' }, [
          el('div', { class: 'title', text: '读取收藏夹失败' }),
          el('div', { class: 'desc', text: res.error || '' }),
        ]),
      );
      return;
    }
    folders = res.data.folders || [];
    if (folders.length && !activeFolderId) activeFolderId = folders[0].id;
    if (!root) return;
    render();
    return;
  }

  // 左：收藏夹列表
  const left = el('div', { class: 'fav-folders' });
  folders.forEach((f) => {
    left.appendChild(
      el('div', {
        class: 'fav-folder' + (f.id === activeFolderId ? ' active' : ''),
        onclick: () => {
          if (activeFolderId === f.id) return;
          activeFolderId = f.id;
          render();
        },
      }, [
        el('span', { class: 'fname', text: f.title }),
        el('span', { class: 'count', text: String(f.mediaCount ?? '') }),
      ]),
    );
  });
  layout.appendChild(left);

  // 右：内容
  const right = el('div', { class: 'fav-content' });
  layout.appendChild(right);
  await renderFolderContent(right);
}

async function renderFolderContent(box) {
  if (!activeFolderId) {
    box.appendChild(el('div', { class: 'empty-state' }, [el('div', { class: 'title', text: '还没有收藏夹' })]));
    return;
  }

  const grid = el('div', { class: 'card-grid' });
  box.appendChild(grid);
  for (let i = 0; i < 8; i++) grid.appendChild(createSkeletonCard());

  const res = await bili.favList({ mediaId: activeFolderId, page: 1, pageSize: 40 });
  if (!root) return;
  grid.innerHTML = '';

  if (!res.ok) {
    grid.appendChild(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'title', text: '读取失败' }),
        el('div', { class: 'desc', text: res.error || '' }),
      ]),
    );
    return;
  }

  const items = res.data.items || [];
  if (!items.length) {
    grid.appendChild(
      el('div', { class: 'empty-state' }, [
        el('div', { class: 'title', text: '这个收藏夹是空的' }),
        el('div', { class: 'desc', text: '去 B 站收藏几个视频再回来' }),
      ]),
    );
    return;
  }
  items.forEach((it) => grid.appendChild(createCard(it)));
}

function renderLoginGuide() {
  const box = el('div', { class: 'fav-login-box' }, [
    el('div', { class: 'big-title', text: '登录后查看你的收藏夹' }),
    el('div', {
      class: 'hint',
      text: '推荐用扫码登录：手机 B 站 App 扫一下即完成。也可拉起系统浏览器登录，或手动粘贴 Cookie。',
    }),
    el('button', {
      class: 'btn primary',
      text: '登录（网页扫码 / Cookie）',
      onclick: () =>
        openLoginModal({
          title: '登录 B 站',
          onSuccess: () => {
            foldersLoaded = false;
            render();
          },
        }),
    }),
  ]);
  root.appendChild(box);
}
