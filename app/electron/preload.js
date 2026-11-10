'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('bili', {
  // 内容
  search: (p) => invoke('api:search', p),
  video: (p) => invoke('api:video', p),
  related: (p) => invoke('api:related', p),
  subtitle: (p) => invoke('api:subtitle', p),
  resolve: (p) => invoke('api:resolve', p),
  ranking: (p) => invoke('api:ranking', p),
  popular: (p) => invoke('api:popular', p),
  playurl: (p) => invoke('api:playurl', p),

  // 账号
  login: (cookie) => invoke('api:login', { cookie }),
  qrLoginCreate: () => invoke('api:qrLoginCreate'),
  qrLoginPoll: (authCode) => invoke('api:qrLoginPoll', { authCode }),
  browserLogin: () => invoke('api:browserLogin'),
  openBiliWeb: (url) => invoke('api:openBiliWeb', url),
  loginStatus: () => invoke('api:loginStatus'),
  logout: () => invoke('api:logout'),
  favFolders: (p) => invoke('api:favFolders', p),
  favList: (p) => invoke('api:favList', p),
  history: (p) => invoke('api:history', p),

  // 配置
  getAllConfig: () => invoke('store:getAll'),
  setConfig: (patch) => invoke('store:set', patch),

  // 窗口
  minimize: () => invoke('window:minimize'),
  maximize: () => invoke('window:maximize'),
  close: () => invoke('window:close'),
  isMaximized: () => invoke('window:isMaximized'),

  // 其它
  openExternal: (url) => invoke('app:openExternal', url),
  img: (url) => invoke('api:img', { url }),
  proxyBase: () => invoke('app:proxyBase'),
  version: () => invoke('app:version'),
  platform: () => invoke('app:platform'),

  // 主进程 -> 渲染进程
  onLoginCaptured: (cb) => {
    const h = (_e, user) => cb(user);
    ipcRenderer.on('auth:loginCaptured', h);
    return () => ipcRenderer.removeListener('auth:loginCaptured', h);
  },
  onPlayerCommand: (cb) => {
    const h = (_e, cmd) => cb(cmd);
    ipcRenderer.on('player:command', h);
    return () => ipcRenderer.removeListener('player:command', h);
  },
  reportPlayerState: (state) => ipcRenderer.send('player:state', state),
});
