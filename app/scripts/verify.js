#!/usr/bin/env node
/**
 * BiliListen 自动化验收（CDP）
 *
 * 前置：本机全局 ELECTRON_RUN_AS_NODE=1，必须清掉；GPU 进程会崩，必须 --disable-gpu。
 * 用法：node scripts/verify.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const exe = typeof electronPath === 'string' ? electronPath : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9471;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.text || 'exception');
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout ' + method));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  console.log('[verify] 启动 Electron ...');
  // --hidden：主进程不 show 窗口，不进任务栏，测试全程无界面打扰
  const child = spawn(exe, [root, `--remote-debugging-port=${PORT}`, '--disable-gpu', '--mute-audio', '--hidden'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => (logs += c.toString()));
  child.stderr.on('data', (c) => (logs += c.toString()));

  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    try {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch {}
  }
  if (!page) {
    console.error('[verify] 无法连接 CDP\n' + logs);
    process.exit(1);
    return;
  }
  console.log('[verify] page:', page.title, page.url);

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await sleep(1500);

  // 现在会记住「上次停在哪一页」，验收前先回发现页，保证起点一致
  await cdp.eval(`(async()=>{const b=document.querySelector('.sidebar-item[data-key="discover"]');if(b){b.click();await new Promise(r=>setTimeout(r,1500));}return true;})()`);

  try {
    // 1. 无白屏
    const bodyLen = await cdp.eval('document.body.innerHTML.length');
    const hasApp = await cdp.eval('!!document.getElementById("app")');
    check('1. 窗口启动无白屏', hasApp && bodyLen > 5000, `bodyLen=${bodyLen}`);

    // 2. 发现页真实卡片
    await sleep(5000);
    const cards = await cdp.eval(`(()=>{
      const cs=[...document.querySelectorAll('.video-card[data-bvid]')];
      const imgs=cs.map(c=>c.querySelector('img')).filter(Boolean);
      return { n: cs.length, bvids: cs.slice(0,3).map(c=>c.dataset.bvid),
               imgOk: imgs.filter(i=>i.src && i.complete && i.naturalWidth>0).length,
               imgTotal: imgs.length,
               firstTitle: cs[0]?.querySelector('.card-title')?.textContent || '' };
    })()`);
    check('2. 发现页真实卡片', cards.n > 0 && !!cards.firstTitle, `卡片=${cards.n} 封面加载=${cards.imgOk}/${cards.imgTotal} 首条=${cards.firstTitle.slice(0, 20)}`);

    // 3. 点卡片能播放（全程静音：--mute-audio + debug bridge 兜底）
    const play = await cdp.eval(`(async()=>{
      const a = window.__bili?.audio;
      if (a) { a.muted = true; }
      const c=document.querySelector('.video-card[data-bvid]');
      if(!c) return {ok:false,reason:'no card'};
      c.click();
      for(let i=0;i<40;i++){
        await new Promise(r=>setTimeout(r,500));
        if (a) a.muted = true;
        const st = window.__bili?.state?.();
        if(st && !st.paused && st.src) return {ok:true, src:st.src.slice(0,50), paused:st.paused, dur:st.duration,
                                                title:st.playing?.title?.slice(0,24), muted:st.muted};
      }
      const st = window.__bili?.state?.();
      return {ok:false, reason:'timeout', st: st ? {paused:st.paused, src:st.src} : null};
    })()`);
    check('3. 点卡片能播放（静音）', !!play.ok, JSON.stringify(play));

    // 4. 倍速（必须走 player.setRate，直接改 audio 会被 store 订阅覆盖）
    const ctrl = await cdp.eval(`(async()=>{
      const api = window.__bili; const a = api?.audio;
      if(!a) return {ok:false, reason:'no audio'};
      a.muted = true;
      // 通过 store 改 rate（player.js 的订阅会同步到 audio.playbackRate）
      api.store.set({ rate: 1.5 });
      await new Promise(r=>setTimeout(r,400));
      return { ok:true, r:a.playbackRate, muted:a.muted };
    })()`);
    check('4. 倍速可控（静音）', ctrl.ok && Math.abs(ctrl.r - 1.5) < 0.02, JSON.stringify(ctrl));

    // 5. 主题切换
    const theme = await cdp.eval(`(async()=>{
      const before=document.documentElement.dataset.theme;
      const btn=document.querySelector('.theme-toggle')||document.querySelector('[title*="主题"]');
      if(!btn) return {before, after:before, reason:'no button'};
      btn.click();
      await new Promise(r=>setTimeout(r,500));
      return { before, after: document.documentElement.dataset.theme };
    })()`);
    check('5. 主题切换', theme.before !== theme.after, JSON.stringify(theme));

    // 6. 控制台
    check('6. 控制台无 error', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));

    // 7. 排行榜（用 router 直跳，避免 sidebar 点击在 eval 上下文里的兼容问题）
    const rank = await cdp.eval(`(async()=>{
      const item=[...document.querySelectorAll('.sidebar-item')].find(i=>i.dataset.key==='ranking');
      if(!item) return {ok:false, reason:'no nav item'};
      item.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      for(let i=0;i<20;i++){
        await new Promise(x=>setTimeout(x,400));
        const rows=document.querySelectorAll('.rank-item');
        if(rows.length>0) return {ok:true, rows:rows.length, tabs:document.querySelectorAll('.tabs .tab').length,
                                    first:rows[0]?.querySelector('.rank-title')?.textContent?.slice(0,20)};
      }
      return {ok:false, reason:'no rows', html: document.getElementById('content')?.innerHTML?.slice(0,200)};
    })()`);
    check('7. 排行榜渲染', !!rank.ok, JSON.stringify(rank));

    // 8. 搜索
    const search = await cdp.eval(`(async()=>{
      const input=document.querySelector('.titlebar-search input');
      if(!input) return {ok:false, reason:'no input'};
      input.value='周杰伦';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
      for(let i=0;i<25;i++){
        await new Promise(r=>setTimeout(r,500));
        const cs=document.querySelectorAll('.video-card[data-bvid]');
        if(cs.length>0) return {ok:true, cards:cs.length, first:cs[0]?.querySelector('.card-title')?.textContent?.slice(0,20)};
      }
      return {ok:false, reason:'no results', route: location.hash};
    })()`);
    check('8. 搜索出结果', !!search.ok, JSON.stringify(search));

    // 9. 全屏播放页
    const np = await cdp.eval(`(async()=>{
      const cover=document.querySelector('.playbar-cover');
      if(!cover) return {ok:false, reason:'no playbar cover'};
      cover.click();
      await new Promise(r=>setTimeout(r,900));
      const ov=document.querySelector('.np-overlay');
      const disc=document.querySelector('.np-disc');
      return {ok: !!ov && ov.classList.contains('open'), hasDisc: !!disc,
              spin: disc ? getComputedStyle(disc).animationName : null,
              title: document.querySelector('.np-title')?.textContent?.slice(0,20)};
    })()`);
    check('9. 全屏播放页展开', !!np.ok, JSON.stringify(np));

    // 10. 队列抽屉
    const q = await cdp.eval(`(async()=>{
      document.querySelector('.np-back')?.click();
      await new Promise(r=>setTimeout(r,400));
      const btn=[...document.querySelectorAll('#playbar .ctrl-btn')].find(b=>b.title==='队列');
      if(!btn) return {ok:false, reason:'no queue btn'};
      btn.click();
      await new Promise(r=>setTimeout(r,600));
      const panel=document.querySelector('.queue-panel');
      return {ok: !!panel && panel.classList.contains('open'), items: document.querySelectorAll('.queue-item').length};
    })()`);
    check('10. 队列抽屉打开', !!q.ok, JSON.stringify(q));
  } catch (e) {
    console.error('[verify] 异常:', e.message);
  }

  cdp.close();
  child.kill();
  await sleep(600);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('[verify] 应用日志:\n' + logs.slice(-2000));
    process.exit(1);
  }
  process.exit(0);
})();
