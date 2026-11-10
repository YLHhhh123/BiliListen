#!/usr/bin/env node
'use strict';
/** 真实点击：播放条封面开全屏播放页 → 点返回关。用法：node scripts/verify-np.js */
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

  // 1. 真实点击播放条封面 → 全屏页展开
  const cover = await cdp.eval(`(()=>{
    const c=document.querySelector('.playbar-cover');
    if(!c) return null;
    const r=c.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (!cover) { console.log('无封面（可能未在播放）'); process.exit(0); }
  await realClick(cdp, cover.x, cover.y);
  await sleep(900);
  let st = await cdp.eval(`(()=>{const o=document.querySelector('.np-overlay');return {open:o?o.classList.contains('open'):false, pe:o?getComputedStyle(o).pointerEvents:'missing'}})()`);
  console.log('点封面 → 全屏页:', JSON.stringify(st));

  // 2. 全屏页里真实点击暂停/播放按钮
  const play = await cdp.eval(`(()=>{
    const b=document.querySelector('.np-controls .ctrl-btn.play');
    if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (play) {
    const before = await cdp.eval(`window.__bili?.state?.()?.paused`);
    await realClick(cdp, play.x, play.y);
    await sleep(600);
    const after = await cdp.eval(`window.__bili?.state?.()?.paused`);
    console.log(`点播放/暂停: paused ${before} -> ${after}`);
  }

  // 3. 真实点返回按钮关闭全屏页
  const back = await cdp.eval(`(()=>{
    const b=document.querySelector('.np-back');
    if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (back) {
    await realClick(cdp, back.x, back.y);
    await sleep(700);
    st = await cdp.eval(`(()=>{const o=document.querySelector('.np-overlay');return {open:o?o.classList.contains('open'):false}})()`);
    console.log('点返回 → 全屏页:', JSON.stringify(st));
  }

  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
