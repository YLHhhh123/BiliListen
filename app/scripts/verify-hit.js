#!/usr/bin/env node
'use strict';
/**
 * 真实点击命中测试（CDP Input.dispatchMouseEvent）
 * 与 verify.js 的 element.click() 不同：Input 走合成器命中测试，
 * pointer-events 拦截行为和真鼠标完全一致。
 * 用法：node scripts/verify-hit.js
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const exe = 'E:\\rea\\bili-listen\\dist\\BiliListen-win32-x64\\BiliListen.exe';
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

(async () => {
  console.log('[hit] 启动打包版 BiliListen ...');
  // 本机全局 ELECTRON_RUN_AS_NODE=1 会把 exe 当 Node 跑，必须清掉
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => (logs += c.toString()));
  child.stderr.on('data', (c) => (logs += c.toString()));

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch {}
  }
  if (!page) {
    console.error('[hit] 连不上 CDP\n' + logs.slice(-1500));
    child.kill();
    process.exit(1);
  }
  console.log('[hit] page:', page.title);

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(3000); // 等首屏渲染

  // A. 关闭态覆盖层的 computed pointer-events
  const pe = await cdp.eval(`(()=>{
    const g=(sel)=>{const n=document.querySelector(sel);return n?getComputedStyle(n).pointerEvents:'missing'};
    return { npOverlay:g('.np-overlay'), queueMask:g('.queue-mask'), queuePanel:g('.queue-panel'),
             npRoot:g('#nowplaying-root'), queueRoot:g('#queue-root') };
  })()`);
  console.log('\nA. 关闭态 pointer-events:', JSON.stringify(pe));

  // B. 命中测试：关键 UI 坐标上的 elementFromPoint
  const hits = await cdp.eval(`(()=>{
    const out=[];
    const probe=(el,label)=>{
      if(!el){out.push({label,hit:'(元素不存在)'});return;}
      const r=el.getBoundingClientRect();
      const t=document.elementFromPoint(r.left+r.width/2, r.top+Math.min(r.height/2, 30));
      out.push({label, hit: t? String(t.className||t.tagName) : 'null'});
    };
    probe(document.querySelector('.sidebar-item'),'侧边栏导航');
    probe(document.querySelector('.video-card[data-bvid]'),'视频卡片');
    probe(document.getElementById('playbar'),'播放条');
    probe(document.querySelector('.titlebar-search'),'标题栏搜索框');
    return out;
  })()`);
  console.log('\nB. 命中测试 (elementFromPoint):');
  hits.forEach((h) => console.log(`   ${h.label} -> ${h.hit}`));

  // C. 真实鼠标点击：侧边栏「排行榜」
  const item = await cdp.eval(`(()=>{
    const it=[...document.querySelectorAll('.sidebar-item')].find(i=>i.dataset.key==='ranking');
    if(!it) return null;
    const r=it.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (item) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: item.x, y: item.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: item.x, y: item.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    const rank = await cdp.eval(`({hash:location.hash, rows:document.querySelectorAll('.rank-item').length})`);
    console.log('\nC. 真实点击侧边栏「排行榜」:', JSON.stringify(rank));
  } else {
    console.log('\nC. 未找到排行榜导航项');
  }

  // D. 真实鼠标点击：播放条队列按钮开抽屉
  const qbtn = await cdp.eval(`(()=>{
    const b=[...document.querySelectorAll('#playbar .ctrl-btn')].find(x=>x.title==='队列');
    if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  if (qbtn) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: qbtn.x, y: qbtn.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: qbtn.x, y: qbtn.y, button: 'left', clickCount: 1 });
    await sleep(800);
    const q = await cdp.eval(`(()=>{const p=document.querySelector('.queue-panel');return {open:p?p.classList.contains('open'):false}})()`);
    console.log('D. 真实点击队列按钮开抽屉:', JSON.stringify(q));
    // 抽屉开着时再查一次 queue-panel / mask 的 pointer-events
    const peOpen = await cdp.eval(`(()=>{
      const g=(sel)=>{const n=document.querySelector(sel);return n?getComputedStyle(n).pointerEvents:'missing'};
      return { queueMask:g('.queue-mask'), queuePanel:g('.queue-panel') };
    })()`);
    console.log('   打开态 pointer-events:', JSON.stringify(peOpen));
    // 真实点击遮罩关闭
    const wm = await cdp.eval(`(()=>({x:Math.round(innerWidth/4), y:Math.round(innerHeight/2)}))()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: wm.x, y: wm.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: wm.x, y: wm.y, button: 'left', clickCount: 1 });
    await sleep(600);
    const q2 = await cdp.eval(`(()=>{const p=document.querySelector('.queue-panel');return {open:p?p.classList.contains('open'):false}})()`);
    console.log('   真实点击遮罩关抽屉:', JSON.stringify(q2));
  } else {
    console.log('D. 未找到队列按钮');
  }

  cdp.close();
  console.log('\n[hit] 完成，应用保持运行。');
  process.exit(0);
})().catch((e) => { console.error('[hit] 异常:', e.message); process.exit(1); });
