// ===== router.js：视图切换 =====
// 用 hash 路由，每个 view 导出 mount(container, params) / unmount()

const routes = {};
let currentView = null;
let currentKey = null;
const navListeners = new Set();

/** 订阅路由切换（用来记「上次停在哪一页」） */
export function onNavigate(fn) {
  navListeners.add(fn);
  return () => navListeners.delete(fn);
}

export function register(name, module) {
  routes[name] = module;
}

export function navigate(name, params = {}) {
  currentKey = name;
  navListeners.forEach((fn) => {
    try { fn(name, params); } catch (e) { console.error('[router listener]', e); }
  });
  if (currentView && typeof currentView.unmount === 'function') {
    try { currentView.unmount(); } catch (e) { console.error('[router unmount]', e); }
  }
  currentView = null;
  const container = document.getElementById('content');
  if (!container) return;
  container.innerHTML = '';
  const mod = routes[name];
  if (!mod) {
    container.innerHTML = `<div class="empty-state"><div class="title">页面不存在</div></div>`;
    return;
  }
  currentView = mod;
  try {
    mod.mount(container, params);
  } catch (e) {
    console.error('[router mount]', e);
    container.innerHTML = `<div class="empty-state"><div class="title">加载失败</div><div class="desc">${e.message}</div></div>`;
  }
}

export function currentRoute() { return currentKey; }
