#!/usr/bin/env node
/**
 * 打包版验收（自动启动 dist\BiliListen.exe，验完自动关）
 * 用法：node scripts/verify-packaged.js [port]
 *
 * 前置：先跑 scripts\build.js 生成 dist。
 * 坑：本机全局 ELECTRON_RUN_AS_NODE=1，必须清掉否则 exe 退化成纯 Node。
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = Number(process.argv[2] || 9481);
const root = path.join(__dirname, '..');
const appDir = path.join(root, '..', 'dist', 'BiliListen-win32-x64');
const exePath = path.join(appDir, 'BiliListen.exe');

const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(exePath)) {
    console.log(`FAIL 找不到打包产物：${exePath}\n先跑 cd ${root} && node scripts\\build.js`);
    process.exit(1);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exePath, [`--remote-debugging-port=${PORT}`, '--disable-gpu', '--hidden', '--mute-audio'], {
    cwd: appDir, env, stdio: 'ignore',
  });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { list = await httpGet(`http://127.0.0.1:${PORT}/json/list`); if (list.length) break; } catch {}
  }
  if (!list || !list.length) { console.log('FAIL 打包版启动超时'); child.kill(); process.exit(1); }

  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.text || 'exc');
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  await sleep(1200);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text, desc: r.exceptionDetails.exception?.description };
    return r.result.value;
  };

  // 0 重置到干净起点（重载页面，避免上次测试留下的路由/状态）
  await ev(`location.reload()`);
  await sleep(4000);

  let pass = 0, fail = 0;
  const check = (n, c, d) => { c ? (pass++, console.log(`PASS  ${n}${d ? '  — ' + d : ''}`)) : (fail++, console.log(`FAIL  ${n}${d ? '  — ' + d : ''}`)); };

  // 1 发现页
  const d = await ev(`({skel:document.querySelectorAll('.skeleton-card').length,cards:document.querySelectorAll('.video-card').length,
    loaded:[...document.querySelectorAll('.card-cover img')].filter(i=>i.naturalWidth>0).length,
    first:(document.querySelector('.card-title')||{}).textContent||''})`);
  check('发现页渲染', d.cards >= 20 && d.skel === 0, `cards=${d.cards} skel=${d.skel} loaded=${d.loaded}`);
  check('卡片有真实标题', !!d.first && d.first.length > 4, d.first.slice(0, 40));

  // 2 播放（点卡片）
  const p = await ev(`(async()=>{
    document.querySelector('.video-card[data-bvid] .card-cover').click();
    await new Promise(r=>setTimeout(r,4000));
    const a=document.querySelector('audio');
    return {src:a?a.src.slice(0,70):'none',dur:a?a.duration:0,paused:a?a.paused:null,title:(document.getElementById('pb-title')||{}).textContent||''};
  })()`);
  check('点击卡片能播放', p && p.src.includes('/audio/') && !p.paused && p.dur > 0, `dur=${p && p.dur} title=${p && (p.title || '').slice(0, 24)}`);

  // 3 倍速 6 档循环
  const rates = await ev(`(async()=>{
    const { nextRate, setRate } = await import('./js/player.js');
    setRate(0.5);
    await new Promise(r=>setTimeout(r,200));
    const out=[Number(document.querySelector('audio').playbackRate)];
    for(let i=0;i<6;i++){ nextRate(); await new Promise(r=>setTimeout(r,150)); out.push(Number(document.querySelector('audio').playbackRate)); }
    return out;
  })()`);
  check('倍速 6 档循环正确', Array.isArray(rates) && rates.join(',') === '0.5,0.75,1,1.25,1.5,2,0.5', JSON.stringify(rates));

  // 4 队列
  const q = await ev(`(async()=>{document.querySelector('.ctrl-btn[title="队列"]').click();await new Promise(r=>setTimeout(r,600));
    return {open:document.querySelector('.queue-panel').classList.contains('open'),n:document.querySelectorAll('.queue-item').length};})()`);
  check('队列抽屉可开', q && q.open === true, `items=${q && q.n}`);
  await ev(`document.querySelector('.queue-mask').click()`);

  // 5 全屏播放页 + 倍速菜单（验证 secondary bug 已修）
  const np = await ev(`(async()=>{
    document.getElementById('pb-cover').click();
    await new Promise(r=>setTimeout(r,800));
    const ov=document.querySelector('.np-overlay');
    const rateBtn=[...document.querySelectorAll('.np-secondary .btn')].find(b=>/×/.test(b.textContent));
    if(!rateBtn) return {open:ov.classList.contains('open'),err:'no rate btn'};
    rateBtn.click();
    await new Promise(r=>setTimeout(r,400));
    const menu=document.querySelector('.np-secondary .rate-menu');
    return {open:ov.classList.contains('open'),menu:!!menu,items:menu?menu.children.length:0,
      labels:menu?[...menu.children].map(b=>b.textContent):[]};
  })()`);
  check('全屏播放页可开', np && np.open === true);
  check('倍速菜单能弹出（修 secondary bug）', np && np.menu === true && np.items === 6, `items=${np && np.items} ${JSON.stringify(np && np.labels)}`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));`);

  // 6 设置页
  const s = await ev(`(async()=>{
    document.querySelector('.sidebar-item[data-key="settings"]').click();
    await new Promise(r=>setTimeout(r,800));
    const rows=[...document.querySelectorAll('.setting-row')].map(r=>(r.querySelector('.setting-label')||{}).textContent);
    return {rows,sel:document.querySelectorAll('select').length,rng:document.querySelectorAll('input[type=range]').length,chk:document.querySelectorAll('input[type=checkbox]').length};
  })()`);
  check('设置页完整', s && s.sel === 1 && s.rng === 1 && s.chk === 1 && s.rows.length >= 7, s.rows.join('/'));

  // 7 无错误
  check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');

  console.log(`\n[verify-packaged] ${pass}/${pass + fail} 通过`);
  ws.close();
  child.kill();
  await sleep(800);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
