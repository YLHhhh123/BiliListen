#!/usr/bin/env node
'use strict';
/**
 * 浏览器登录链路验证（对已运行的打包版，调试端口 9472）
 * 验证：IPC 注册 / 回传页渲染 / 伪 Cookie 校验拒绝 / 渲染层推送 / 登录态联动
 * 用法：node scripts/verify-browser-login.js
 */
const http = require('http');
const PORT = 9472;
const CAPTURE_PORT = 45872;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const list = JSON.parse(await new Promise((res2, rej) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res2(d)); }).on('error', rej);
  }));
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('无页面'); process.exit(1); }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 1. IPC 存在
  const ipc = await cdp.eval(`({bl: typeof window.bili.browserLogin, cap: typeof window.bili.onLoginCaptured, old: typeof window.bili.webLogin})`);
  check('1. browserLogin/onLoginCaptured 已注册，webLogin 已移除', ipc.bl === 'function' && ipc.cap === 'function' && ipc.old === 'undefined', JSON.stringify(ipc));

  // 2. 挂监听（模拟 login.js / app.js 的订阅）
  await cdp.eval(`(window.__capEvents = window.__capEvents || [], !!window.bili.onLoginCaptured && (window.__unsubCap = window.bili.onLoginCaptured(u => window.__capEvents.push(u)), true))`);

  // 3. 回传页渲染
  const land = await httpGetRaw(`http://127.0.0.1:${CAPTURE_PORT}/land`);
  check('3. 回传页 /land 200 + 书签按钮', land.status === 200 && land.body.includes('回传 BiliListen') && land.body.includes('javascript:'), `status=${land.status} len=${land.body.length}`);

  // 4. 伪 Cookie 回传 → 主进程 checkLogin → 拒绝 → 渲染层收到 ok:false 推送
  const cb = await httpGetRaw(`http://127.0.0.1:${CAPTURE_PORT}/cb?c=SESSDATA=fake123; DedeUserID=1`);
  await sleep(1200);
  const cap = await cdp.eval(`window.__capEvents`);
  check('4. 伪 Cookie 校验拒绝并推送渲染层', cb.status === 200 && cb.body.includes('校验失败') && cap.length === 1 && cap[0] === null, `cb=校验失败页 capEvents=${JSON.stringify(cap)}`);

  // 5. 空回传安全
  const cbEmpty = await httpGetRaw(`http://127.0.0.1:${CAPTURE_PORT}/cb`);
  check('5. 空 Cookie 回传安全拒绝', cbEmpty.status === 200 && cbEmpty.body.includes('Cookie 为空'), '');

  // 6. 登录态接口仍正常（用户可能已登录）
  const st = await cdp.eval(`window.bili.loginStatus().then(r=>r.ok?{isLogin:r.data.isLogin,uname:r.data.uname}:{err:r.error})`);
  check('6. 登录态查询正常', st && typeof st.isLogin === 'boolean', JSON.stringify(st));

  // 7. 控制台无 error
  // （不单独收集，走整体异常）

  cdp.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify-browser-login] ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
