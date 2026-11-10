#!/usr/bin/env node
'use strict';
/**
 * 对已运行的 BiliListen（打包版，调试端口 9472）做真实鼠标点击回归。
 * 用法：node scripts/verify-nav.js
 */
const http = require('http');
const PORT = 9472;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
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

async function realClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

(async () => {
  const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.error('无页面'); process.exit(1); }
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const route = () => cdp.eval(`({route:(window.__bili?.route?.()||''), items:[...document.querySelectorAll('#content .rank-item,#content .video-card[data-bvid],#content .setting-row,#content .history-item')].length, first:(document.querySelector('#content .rank-title,#content .card-title,#content .setting-label,#content .history-title')||{}).textContent||''})`);

  console.log('当前:', JSON.stringify(await route()));

  for (const key of ['ranking', 'history', 'settings', 'discover']) {
    const pt = await cdp.eval(`(()=>{
      const it=[...document.querySelectorAll('.sidebar-item')].find(i=>i.dataset.key==='${key}');
      if(!it) return null;
      const r=it.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
    })()`);
    if (!pt) { console.log(`${key}: 导航项不存在`); continue; }
    await realClick(cdp, pt.x, pt.y);
    await sleep(1500);
    const st = await route();
    console.log(`${key}: route=${st.route} 渲染条目=${st.items} 首条=${String(st.first).slice(0,18)}`);
  }

  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
