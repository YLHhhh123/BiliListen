#!/usr/bin/env node
/**
 * 登录功能专项验收（静默、无窗口）
 * 用法：node scripts/verify-login.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const exe = typeof electronPath === 'string' ? electronPath : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9472;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}

class CDP {
  constructor(ws) {
    this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map();
    this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve } = this.pending.get(m.id); this.pending.delete(m.id); resolve(m); }
    };
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((r) => { this.pending.set(id, { resolve: r }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const child = spawn(exe, [root, `--remote-debugging-port=${PORT}`, '--disable-gpu', '--mute-audio', '--hidden'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => (logs += c));
  child.stderr.on('data', (c) => (logs += c));

  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    try { page = (await httpGet(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && t.url.includes('index.html')); if (page) break; } catch {}
  }
  if (!page) { console.error('CDP 连不上\n' + logs); process.exit(1); }

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(3500);

  try {
    // 1. 扫码：申请二维码
    const qr = await cdp.eval(`window.bili.qrLoginCreate().then(r=>r.ok?{ok:true,url:r.data.url,hasImg:!!r.data.qrDataUrl,imgLen:r.data.qrDataUrl.length,authCode:r.data.authCode,exp:r.data.expiresIn}:{ok:false,err:r.error})`);
    check('1. 扫码登录：二维码生成', !!qr.ok && qr.hasImg && qr.url.includes('passport.bilibili.com'), JSON.stringify({ host: qr.url ? new URL(qr.url).host : '', imgLen: qr.imgLen, exp: qr.exp }));

    // 2. 二维码内容必须是 B 站 official TV 登录域
    check('2. 二维码指向官方 TV 登录域', /^https:\/\/passport\.bilibili\.com\/x\/passport-tv-login\//.test(qr.url || ''), qr.url?.slice(0, 70));

    // 3. 轮询返回 waiting
    await sleep(1500);
    const poll = await cdp.eval(`window.bili.qrLoginPoll(${JSON.stringify(qr.authCode)}).then(r=>r.ok?{status:r.data.status}:{err:r.error})`);
    check('3. 扫码：轮询状态正常', poll.status === 'waiting' || poll.status === 'scanned', JSON.stringify(poll));

    // 4. 浏览器登录：检查 IPC 存在（不真的拉起浏览器，避免打扰）
    const webFn = await cdp.eval(`typeof window.bili.browserLogin`);
    check('4. 浏览器登录：IPC 已注册', webFn === 'function', webFn);

    // 5. Cookie 登录：空 Cookie 应报错而不是崩
    const badCookie = await cdp.eval(`window.bili.login('').then(r=>({ok:r.ok,isLogin:r.data?.isLogin,err:r.error}))`);
    check('5. Cookie 登录：空值安全拒绝', badCookie.isLogin === false || badCookie.ok === false, JSON.stringify(badCookie));

    // 6. 登录态查询
    const st = await cdp.eval(`window.bili.loginStatus().then(r=>r.ok?r.data:{err:r.error})`);
    check('6. 登录态查询可用', st && typeof st.isLogin === 'boolean', JSON.stringify(st));

    // 7. 三种方式的 UI 入口存在
    const ui = await cdp.eval(`(async()=>{
      const { openLoginModal } = await import('./js/components/login.js');
      openLoginModal({});
      await new Promise(r=>setTimeout(r,900));
      const tabs=[...document.querySelectorAll('.modal .seg-tab')].map(t=>t.textContent);
      const hasQrImg=!!document.querySelector('.modal .qr-img');
      return { tabs, hasQrImg };
    })()`);
    check('7. 登录弹层三 Tab（扫码/网页/Cookie）', ui.tabs.length === 3 && ui.hasQrImg, JSON.stringify(ui));

    // 8. 二维码在弹层里真的渲染出来
    await sleep(2500);
    const qrRendered = await cdp.eval(`(()=>{const i=document.querySelector('.modal .qr-img'); return i?{hasSrc:i.src.startsWith('data:image/png'),w:i.naturalWidth}:null})()`);
    check('8. 弹层内二维码实际渲染', !!qrRendered && qrRendered.hasSrc && qrRendered.w > 0, JSON.stringify(qrRendered));
  } catch (e) {
    console.error('异常:', e.message);
  }

  cdp.close();
  child.kill();
  await sleep(500);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify-login] ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
