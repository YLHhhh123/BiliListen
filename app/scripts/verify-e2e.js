#!/usr/bin/env node
'use strict';
/** 真实点击全链路：卡片播放 → 封面开全屏页 → 返回关。用法：node scripts/verify-e2e.js */
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

  // 静音，避免打扰
  await cdp.eval(`(()=>{const a=document.querySelector('audio'); if(a) a.muted=true;})()`);
  const keepMuted = setInterval(async () => {
    try { await cdp.eval(`(()=>{const a=document.querySelector('audio'); if(a) a.muted=true;})()`); } catch {}
  }, 800);

  // 1. 真实点击第一张视频卡片播放
  const card = await cdp.eval(`(()=>{
    const c=document.querySelector('.video-card[data-bvid]');
    if(!c) return null;
    const r=c.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+Math.min(r.height/2,60))};
  })()`);
  if (!card) { console.log('无卡片'); clearInterval(keepMuted); process.exit(1); }
  await realClick(cdp, card.x, card.y);
  let playing = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    playing = await cdp.eval(`!!window.__bili?.state?.()?.playing`);
    if (playing) break;
  }
  console.log('1. 点卡片播放:', playing ? 'OK' : 'FAIL');
  if (!playing) { clearInterval(keepMuted); process.exit(1); }

  // 2. 真实点击播放条封面 → 全屏页展开
  const cover = await cdp.eval(`(()=>{
    const c=document.querySelector('#pb-cover');
    if(!c) return null;
    const r=c.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  await realClick(cdp, cover.x, cover.y);
  await sleep(900);
  let np = await cdp.eval(`(()=>{const o=document.querySelector('.np-overlay');return {open:o?o.classList.contains('open'):false, pe:o?getComputedStyle(o).pointerEvents:'missing'}})()`);
  console.log('2. 点封面开全屏页:', JSON.stringify(np));

  // 3. 全屏页内真实点击黑胶区域附近的按钮（倍速菜单开关）验证内部交互
  const rateBtn = await cdp.eval(`(()=>{
    const b=document.querySelector('.np-secondary .btn.ghost');
    if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (rateBtn) {
    await realClick(cdp, rateBtn.x, rateBtn.y);
    await sleep(500);
    const menu = await cdp.eval(`!!document.querySelector('.np-secondary .rate-menu')`);
    console.log('3. 全屏页内点倍速按钮弹菜单:', menu ? 'OK' : 'FAIL');
    // 点别处关菜单
    await realClick(cdp, rateBtn.x, rateBtn.y - 120);
    await sleep(400);
  }

  // 4. 真实点返回关全屏页
  const back = await cdp.eval(`(()=>{
    const b=document.querySelector('.np-back');
    if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  await realClick(cdp, back.x, back.y);
  await sleep(700);
  const closed = await cdp.eval(`(()=>{const o=document.querySelector('.np-overlay');return {open:o?o.classList.contains('open'):false, pe:o?getComputedStyle(o).pointerEvents:'missing'}})()`);
  console.log('4. 点返回关全屏页:', JSON.stringify(closed));

  clearInterval(keepMuted);
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
