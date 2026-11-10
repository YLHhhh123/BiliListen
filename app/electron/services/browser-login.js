'use strict';
/**
 * 浏览器登录回传服务
 *
 * 应用不再内置登录窗口（验证码/风控在 Electron 里体验差），
 * 改为拉起系统默认浏览器登录，登录后把 Cookie 送回本地：
 *
 *  1. 本地在 127.0.0.1 起一个只回环的 HTTP 服务（端口 45872 起，被占则向后找）
 *  2. shell.openExternal 打开 passport.bilibili.com/login?gourl=<回传页>
 *  3. 用户在真浏览器里完成登录（极验/滑块/密码/扫码都是原生体验）
 *  4. 登录成功 passport 跳到回传页 → 页面里有可拖到书签栏的「回传书签」
 *  5. 用户在任意 bilibili.com 标签页点该书签 → document.cookie 发回 /cb
 *     （SESSDATA/DedeUserID 都不是 HttpOnly，document.cookie 可读）
 *  6. main 注入的 onCapture 校验 Cookie（checkLogin）→ 落盘配置 → 推送渲染层
 *
 * 安全：只绑 127.0.0.1；回传的 Cookie 会先经官方接口校验登录态才落盘。
 */
const http = require('http');

const BASE_PORT = 45872;
const MAX_TRIES = 10;

const STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e6e6;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 14px; padding: 34px 38px; max-width: 560px; }
  h1 { font-size: 20px; margin-bottom: 6px; color: #fb7299; }
  .sub { font-size: 13px; color: #8a90a0; margin-bottom: 20px; }
  ol { margin: 0 0 22px 20px; font-size: 14px; line-height: 2; color: #c9cdd8; }
  b { color: #fff; }
  .bookmarklet { display: inline-block; padding: 10px 22px; background: #fb7299; color: #fff; border-radius: 999px;
         font-size: 14px; font-weight: 600; cursor: grab; text-decoration: none; user-select: none; }
  .bookmarklet:active { cursor: grabbing; }
  .tip { margin-top: 18px; font-size: 12px; color: #8a90a0; line-height: 1.8; }
  a.plain { color: #66b3ff; }
  .ok-box, .err-box { padding: 18px 22px; border-radius: 10px; font-size: 14px; line-height: 1.8; }
  .ok-box { background: rgba(82,196,26,.12); border: 1px solid rgba(82,196,26,.5); color: #b7eb8f; }
  .err-box { background: rgba(251,114,153,.12); border: 1px solid rgba(251,114,153,.5); color: #ffb3c2; }
`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class BrowserLoginServer {
  constructor() {
    this.server = null;
    this.port = 0;
    /** async (cookie) => { ok, message }，由 main 注入：校验 + 落盘 + 通知渲染层 */
    this.onCapture = null;
  }

  /** 幂等启动；端口被占依次向后试，保证跨次运行端口稳定（书签不失效） */
  async start() {
    if (this.server) return this.port;
    for (let i = 0; i < MAX_TRIES; i++) {
      const port = BASE_PORT + i;
      const bound = await new Promise((resolve) => {
        const srv = http.createServer((req, res) => this._route(req, res));
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.port = port;
          resolve(true);
        });
      });
      if (bound) return this.port;
    }
    throw new Error(`本地回传端口 ${BASE_PORT}-${BASE_PORT + MAX_TRIES - 1} 全被占用`);
  }

  get landUrl() {
    return `http://127.0.0.1:${this.port}/land`;
  }

  get passportUrl() {
    return `https://passport.bilibili.com/login?gourl=${encodeURIComponent(this.landUrl)}`;
  }

  get bookmarklet() {
    const cb = `http://127.0.0.1:${this.port}/cb?c=`;
    // SESSDATA / DedeUserID 任一存在即认为拿到登录 Cookie（都是非 HttpOnly，document.cookie 可读）
    return (
      "javascript:(function(){var c=document.cookie;" +
      "if(!/SESSDATA|DedeUserID/.test(c)){alert('当前页面没有B站登录Cookie，请先切到bilibili.com的页面再点');return;}" +
      "location.href='" + cb + "'+encodeURIComponent(c);})();"
    );
  }

  _route(req, res) {
    const u = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (u.pathname === '/land') return this._land(res);
    if (u.pathname === '/cb') return this._cb(u, res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  _land(res) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BiliListen 回传页</title><style>${STYLE}</style></head>
<body><div class="card">
  <h1>BiliListen 浏览器登录</h1>
  <div class="sub">最后一步：把登录 Cookie 从浏览器带回应用</div>
  <ol>
    <li>把下面的粉色按钮<b>拖到浏览器书签栏</b>（看不到书签栏按 <b>Ctrl+Shift+B</b>）</li>
    <li>切到任意 <b>bilibili.com</b> 标签页（<a class="plain" href="https://www.bilibili.com/" target="_blank">打开 B 站</a>）</li>
    <li>点书签栏里的「回传 BiliListen」，应用会自动完成登录</li>
  </ol>
  <a class="bookmarklet" href="${esc(this.bookmarklet)}">🔐 回传 BiliListen</a>
  <div class="tip">只读取当前页面的 Cookie 并发往本机 127.0.0.1，不经过任何第三方；书签保留后，下次登录无需重复拖拽。</div>
</div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  async _cb(u, res) {
    const cookie = u.searchParams.get('c') || '';
    let ok = false;
    let msg = 'Cookie 为空';
    if (cookie && this.onCapture) {
      try {
        const r = await this.onCapture(cookie);
        ok = !!r.ok;
        msg = r.message || (ok ? '登录成功' : '校验失败');
      } catch (e) {
        msg = e.message || String(e);
      }
    }
    const box = ok
      ? `<div class="ok-box">✅ ${esc(msg)}</div>`
      : `<div class="err-box">❌ ${esc(msg)}</div>`;
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>回传结果</title><style>${STYLE}</style></head>
<body><div class="card"><h1>BiliListen</h1><div class="sub">Cookie 回传结果</div>${box}
<div class="tip">可以关闭本页，回到 BiliListen 查看登录状态。</div></div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
      this.port = 0;
    }
  }
}

module.exports = { BrowserLoginServer };
