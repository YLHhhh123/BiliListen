#!/usr/bin/env node
/**
 * verify-sealed-e2e.js —— 真机（dev electron + 真实 DPAPI）集成验收
 *
 *  1. 临时数据目录 + 旧版明文 cookie 预置 → 启动 → 磁盘应自动迁移成加密信封
 *  2. getAllConfig 不下发 cookie；cookieSealed 标记存在
 *  3. 渲染层 setConfig 携带 cookie/user → 被剥离，磁盘不落
 *  4. 重启 → sealed 配置正常加载（解密链路真实跑通）
 *
 * 用法：node scripts/verify-sealed-e2e.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const exe = typeof electronPath === 'string' ? electronPath : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9481;

const dataDir = path.join(os.tmpdir(), `bili-sealed-e2e-${Date.now()}`);
const cfgPath = path.join(dataDir, 'bili-listen-config.json');
const LEGACY_COOKIE = 'SESSDATA=e2e-fake-sessdata%2C1799999999%2Cdeadbeef%2A91; DedeUserID=123456; bili_jct=cafebeef';

/** 收集子进程 stdout/stderr，第 10 项失败时把主进程日志打出来 */
const childLogs = [];
function collectLogs(app, tag) {
  app.child.stdout && app.child.stdout.on('data', (d) => childLogs.push(`[${tag}] ` + d.toString()));
  app.child.stderr && app.child.stderr.on('data', (d) => childLogs.push(`[${tag}][err] ` + d.toString()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`PASS  ${n}${d ? '  — ' + d : ''}`); }
  else { fail++; console.log(`FAIL  ${n}${d ? '  — ' + d : ''}`); }
};

function launch(envExtra = {}) {  const env = { ...process.env, ...envExtra, BILI_LISTEN_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--hidden', '--mute-audio'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stopAll() {
  try {
    const rootDir = root.replace(/'/g, "''");
    require('child_process').execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore' });
  } catch {}
}

async function connect(child) {
  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { list = await httpGet(`http://127.0.0.1:${PORT}/json/list`); if (list.length) break; } catch {}
  }
  if (!list || !list.length) throw new Error('CDP 启动超时');
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  };
  return { ws, ev, errs, child, logs: [] };
}

async function killApp(app) {
  try { app.ws.close(); } catch {}
  try { require('child_process').execFileSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  stopAll();
  await sleep(800);
}

(async () => {
  try {
    stopAll();
    fs.mkdirSync(dataDir, { recursive: true });
    // 预置旧版明文配置
    fs.writeFileSync(cfgPath, JSON.stringify({ cookie: LEGACY_COOKIE, user: { mid: 123456 }, theme: 'light', volume: 0.66 }, null, 2), 'utf8');
    console.log(`[e2e] 临时数据目录：${dataDir}\n`);

    // ---------- 第一次启动：自动迁移 + 密钥延迟落盘 ----------
    let app = await connect(launch());
    collectLogs(app, 'run1');
    await sleep(3000);
    const view1 = await app.ev(`(async()=>{ const c = await window.bili.getAllConfig(); return { theme: c.theme, volume: c.volume, hasCookieKey: 'cookie' in c, cookieSealed: c.cookieSealed, user: c.user }; })()`);
    check('1. getAllConfig 不含 cookie 字段', view1 && view1.hasCookieKey === false, JSON.stringify(view1));
    check('2. getAllConfig 保留公开配置', view1 && view1.theme === 'light' && view1.volume === 0.66, view1 && `theme=${view1.theme} volume=${view1.volume}`);
    check('3. cookieSealed 标记存在', view1 && view1.cookieSealed === true);

    // 全新数据目录没有 Local State：os_crypt 主密钥由 ImportantFileWriter 延迟
    // 落盘（实测约 10 秒）。主进程会后台等密钥就绪再补做密封，这里等它完成，
    // 覆盖「全新安装 → 密钥落盘 → 自动密封」这条真实链路。
    let sealed = false;
    for (let i = 0; i < 70; i++) {
      try {
        const d = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (d.cookie && d.cookie.__sealed === 1) { sealed = true; break; }
      } catch {}
      await sleep(300);
    }
    check('4. 密钥落盘后自动补做密封', sealed, sealed ? '' : '等待 21 秒仍未密封');

    // 渲染层注入攻击：setConfig 携带 cookie/user
    await app.ev(`(async()=>{ await window.bili.setConfig({ theme: 'dark', cookie: 'HACKED-cookie-from-renderer', user: { mid: 666, uname: 'attacker' } }); })()`);
    await sleep(700);
    const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('5. 磁盘 cookie 是加密信封', typeof disk.cookie === 'object' && disk.cookie && disk.cookie.__sealed === 1, disk.cookie && typeof disk.cookie);
    check('6. 磁盘无明文假 cookie', !JSON.stringify(disk).includes('HACKED-cookie-from-renderer'));
    check('7. 磁盘无明文旧 cookie', !JSON.stringify(disk).includes('e2e-fake-sessdata'), '迁移后明文必须消失');
    check('8. 渲染层无法写 user', !(disk.user && disk.user.mid === 666), JSON.stringify(disk.user));
    check('9. 正常字段照常持久化', disk.theme === 'dark');
    await killApp(app);

    // ---------- 第二次启动：加密配置正常解密恢复 ----------
    app = await connect(launch());
    collectLogs(app, 'run2');
    await sleep(3000);
    const view2 = await app.ev(`(async()=>{ const c = await window.bili.getAllConfig(); return { theme: c.theme, hasCookieKey: 'cookie' in c, user: c.user }; })()`);
    check('10. 重启后加密配置可加载', view2 && view2.theme === 'dark', view2 && `theme=${view2.theme}`);
    check('11. 重启后 user（公开字段）保留', view2 && view2.user && view2.user.mid === 123456, JSON.stringify(view2 && view2.user));
    check('12. 无控制台错误', app.errs.length === 0, app.errs.slice(0, 2).join(' | ') || 'clean');
    await killApp(app);
  } catch (e) {
    console.error('ERR', e.message || e);
    fail++;
  } finally {
    if (fail > 0 && childLogs.length) {
      console.log('\n----- 主进程日志（失败时输出）-----');
      console.log(childLogs.join('').slice(-6000));
      console.log('----- 日志结束 -----');
    }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n[verify-sealed-e2e] ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
