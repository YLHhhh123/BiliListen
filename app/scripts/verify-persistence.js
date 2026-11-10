#!/usr/bin/env node
/**
 * 持久化验收：关掉再开，队列 / 播放断点 / 页面 还在不在
 *
 * 做法：用临时数据目录（BILI_LISTEN_DATA_DIR）跑打包版，塞一份播放现场，
 * 杀掉进程（模拟用户关窗口/关机），再启动一次读回来。
 * 不碰真实配置，不会影响已登录的账号。
 *
 * 用法：node scripts/verify-persistence.js
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 9483;
const root = path.join(__dirname, '..');
const exePath = path.join(root, '..', 'dist', 'BiliListen-win32-x64', 'BiliListen.exe');
const dataDir = path.join(os.tmpdir(), `bili-listen-persist-${Date.now()}`);
const cfgPath = path.join(dataDir, 'bili-listen-config.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

let pass = 0;
let fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`PASS  ${n}${d ? '  — ' + d : ''}`); }
  else { fail++; console.log(`FAIL  ${n}${d ? '  — ' + d : ''}`); }
};

function launch() {
  // 先确保没有残留实例：Electron 的单实例锁会让新进程静默退出，
  // 表现就是「CDP 连上了但读到的是旧进程的状态」，排查起来很浪费时间。
  stopAll();
  const env = { ...process.env, BILI_LISTEN_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(exePath, [`--remote-debugging-port=${PORT}`, '--disable-gpu', '--hidden', '--mute-audio'], {
    cwd: path.dirname(exePath), env, stdio: 'ignore',
  });
}

/** 只结束 dist 目录里的本程序，不误伤别的进程 */
function stopAll() {
  try {
    const dir = path.dirname(exePath).replace(/'/g, "''");
    require('child_process').execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Process | Where-Object { $_.Path -like '${dir}\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore' });
  } catch {}
}

async function connect(child) {
  let list = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try { list = await httpGet(`http://127.0.0.1:${PORT}/json/list`); if (list.length) break; } catch {}
  }
  if (!list || !list.length) throw new Error('应用启动超时（CDP 没起来）');
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const errs = [];
  const send = (m, p = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.text || 'exc');
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text, desc: r.exceptionDetails.exception?.description };
    return r.result.value;
  };
  return { ws, ev, errs, child };
}

async function killApp(app) {
  try { app.ws.close(); } catch {}
  // 树杀：只 kill 主进程的话，渲染/GPU 子进程会残留并占住单实例锁
  try { require('child_process').execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  stopAll();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { await httpGet(`http://127.0.0.1:${PORT}/json/list`); } catch { break; }
  }
  await sleep(600);
}

(async () => {
  if (!fs.existsSync(exePath)) {
    console.log(`FAIL 找不到打包产物：${exePath}\n先跑 node scripts\\build.js`);
    process.exit(1);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[persist] 临时数据目录：${dataDir}\n`);

  // ---------- 第一次启动：造一份播放现场 ----------
  let app = await connect(launch());
  await sleep(2500);

  const seeded = await app.ev(`(async()=>{
    const st = window.__bili.store;
    const mk = (n, title) => ({key:'BV1xx411c7m'+n+'_'+n, bvid:'BV1xx411c7m'+n, cid:Number(n), title, author:'测试UP', cover:'', duration:300});
    const queue = [mk(1,'测试曲目A'), mk(2,'测试曲目B'), mk(3,'测试曲目C')];
    st.set({ queue, currentIndex: 1, playing: queue[1], currentTime: 137, duration: 300, progress: 137/300 });
    return { q: st.get().queue.length, cur: st.get().currentIndex };
  })()`);
  check('能写入播放现场', seeded && seeded.q === 3, JSON.stringify(seeded));

  // 切到设置页，验证「上次停在哪页」也能记住
  await app.ev(`(async()=>{document.querySelector('.sidebar-item[data-key="settings"]').click();await new Promise(r=>setTimeout(r,600));})()`);
  await sleep(1800); // 等 session 防抖（800ms）+ 配置落盘（150ms）

  await killApp(app);

  // ---------- 检查磁盘 ----------
  check('配置文件已生成', fs.existsSync(cfgPath), cfgPath);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { saved = null; }
  check('配置是合法 JSON（强杀也没写坏）', !!saved);
  check('队列写进了磁盘', saved && saved.session && saved.session.queue.length === 3,
    `queue=${saved?.session?.queue?.length}`);
  check('断点秒数落盘', saved && saved.session && saved.session.position >= 130,
    `position=${saved?.session?.position}`);
  check('当前曲目落盘', saved && saved.session && saved.session.playing?.title === '测试曲目B',
    saved?.session?.playing?.title);
  check('上次页面落盘', saved && saved.lastRoute === 'settings', `lastRoute=${saved?.lastRoute}`);
  check('没有残留 .tmp 文件', !fs.existsSync(cfgPath + '.tmp'));

  // ---------- 第二次启动：应该原样恢复 ----------
  app = await connect(launch());
  await sleep(2600);
  const back = await app.ev(`(async()=>{
    const cfg = await window.bili.getAllConfig();
    const s = window.__bili.store.get();
    return {
      n: s.queue.length,
      cur: s.currentIndex,
      title: s.playing && s.playing.title,
      t: Math.round(s.currentTime),
      dur: Math.round(s.duration),
      isPlaying: s.isPlaying,
      page: (document.querySelector('.page-title')||{}).textContent || '',
      bar: (document.getElementById('pb-title')||{}).textContent || '',
      src: (document.querySelector('audio')||{}).src || '',
      cfgDir: cfg && cfg.dataDir,
      cfgHasSession: !!(cfg && cfg.session),
      cfgQueue: cfg && cfg.session ? cfg.session.queue.length : null,
    };
  })()`);
  if (back && (!back.cfgHasSession || back.n !== 3)) {
    console.log(`     诊断：dataDir=${back.cfgDir} 磁盘上有 session=${back.cfgHasSession} 队列=${back.cfgQueue} 界面队列=${back.n}`);
  }
  check('重启后队列还在', back && back.n === 3, `queue=${back?.n}`);
  check('重启后选中项还在', back && back.cur === 1, `index=${back?.cur}`);
  check('重启后曲目还在', back && back.title === '测试曲目B', back?.title);
  check('重启后断点秒数还在', back && Math.abs(back.t - 137) <= 2, `${back?.t}s / ${back?.dur}s`);
  check('不会自动出声', back && back.isPlaying === false, `isPlaying=${back?.isPlaying}`);
  check('播放条显示上次的曲子', back && back.bar.includes('测试曲目B'), back?.bar?.slice(0, 30));
  check('回到上次停留的页面', back && back.page === '设置', back?.page);
  check('没有提前去取音频地址', back && !back.src, back?.src ? 'src 非空' : 'src 为空，点播放才取');

  // 点播放要能从断点接着放（这里只验它会去重新取地址，不等真的出声）
  const resume = await app.ev(`(async()=>{
    document.querySelector('.play-btn, .ctrl-btn[title="播放"], #pb-play')?.click?.();
    await new Promise(r=>setTimeout(r,1500));
    const s = window.__bili.store.get();
    return { t: Math.round(s.currentTime), title: s.playing && s.playing.title };
  })()`);
  check('点播放会接着上一首继续', resume && Math.abs(resume.t - 137) <= 3, `${resume?.t}s`);

  check('启动无控制台错误', app.errs.length === 0, app.errs.slice(0, 2).join(' | ') || 'clean');

  await killApp(app);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}

  console.log(`\n[verify-persistence] ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e.message || e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
