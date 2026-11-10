#!/usr/bin/env node
'use strict';
/** 真实点击「浏览器登录」按钮（会拉起系统默认浏览器）。对已运行打包版 9472。 */
const http = require('http');
const PORT = 9472;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  const list = await new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
  const page = list.find((t) => t.type === 'page');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // 打开登录弹层 → 切「浏览器登录」Tab
  await cdp.eval(`(async()=>{
    const { openLoginModal } = await import('./js/components/login.js');
    openLoginModal({ title: '登录 B 站' });
    await new Promise(r=>setTimeout(r,600));
    const tab=[...document.querySelectorAll('.modal .seg-tab')].find(t=>t.textContent.includes('浏览器登录'));
    tab.click();
    await new Promise(r=>setTimeout(r,400));
    return document.querySelector('.modal .btn.primary')?.textContent;
  })()`).then((t) => console.log('弹层Tab按钮:', t));

  // 真实鼠标点击按钮 → shell.openExternal 拉起默认浏览器
  const pt = await cdp.eval(`(()=>{
    const b=document.querySelector('.modal .btn.primary');
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(2500);

  const after = await cdp.eval(`(()=>({
    btn: document.querySelector('.modal .btn.primary')?.textContent,
    steps: document.querySelector('.modal .qr-status')?.textContent?.slice(0, 40),
  }))()`);
  console.log('点击后状态:', JSON.stringify(after, null, 1));

  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
