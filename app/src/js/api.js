// ===== api.js：封装 window.bili，统一错误处理 =====
// 所有方法都返回 Promise<{ ok, data | error }>，调用方判断 ok 即可，错误统一走 toast。

const api = window.bili;

/** 把 bili 方法包一层，失败时 toast.error 并返回 ok:false */
function wrap(name) {
  return async (...args) => {
    try {
      const res = await api[name](...args);
      if (!res || res.ok === false) {
        const msg = (res && res.error) || `${name} 失败`;
        // 静默错误不在此 toast，由调用方决定；这里只返回结构化结果
        return { ok: false, error: msg, code: res?.code };
      }
      return { ok: true, data: res.data };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  };
}

export const bili = {
  search: wrap('search'),
  video: wrap('video'),
  related: wrap('related'),
  ranking: wrap('ranking'),
  popular: wrap('popular'),
  playurl: wrap('playurl'),
  subtitle: wrap('subtitle'),
  resolve: wrap('resolve'),
  login: wrap('login'),
  qrLoginCreate: wrap('qrLoginCreate'),
  qrLoginPoll: wrap('qrLoginPoll'),
  browserLogin: wrap('browserLogin'),
  openBiliWeb: (u) => api.openBiliWeb?.(u),
  loginStatus: wrap('loginStatus'),
  logout: wrap('logout'),
  favFolders: wrap('favFolders'),
  favList: wrap('favList'),
  history: wrap('history'),
  getAllConfig: wrap('getAllConfig'),
  setConfig: wrap('setConfig'),
  minimize: () => api.minimize?.(),
  maximize: () => api.maximize?.(),
  close: () => api.close?.(),
  isMaximized: () => api.isMaximized?.(),
  openExternal: (u) => api.openExternal?.(u),
  img: (u) => api.img?.(u),
  proxyBase: () => api.proxyBase?.(),
  version: () => api.version?.(),
  platform: () => api.platform?.(),
  onLoginCaptured: (cb) => api.onLoginCaptured?.(cb),
  onPlayerCommand: (cb) => api.onPlayerCommand?.(cb),
  reportPlayerState: (s) => api.reportPlayerState?.(s),
};
