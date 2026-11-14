#!/usr/bin/env node
/**
 * verify-interactions-e2e.js —— v1.1.2 真机 e2e（CDP）
 *
 *  1. 互动入口按钮存在
 *  2. 一级菜单三项（投币/收藏/关注）
 *  3. 投币二级菜单（1币/2币）+ 未登录时的失败反馈（不花真币）
 *  4. 返回一级菜单 / ESC 关闭
 *  5. 收藏二级菜单（收藏夹读取失败时降级到默认收藏夹）
 *  6. 关注二级菜单（关注/取关）
 *  7. 字幕链路结构化状态（lyricsStatus / lyricsMessage），不再是静默空数组
 *  8. 无渲染层异常
 *
 * 用独立临时数据目录 + 空登录态：所有写接口在主进程直接以「未登录」拒绝，
 * 不发真实网络请求、不动真实账号、不消耗硬币。
 * 用法：node scripts/verify-interactions-e2e.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const exe = typeof electronPath === 'string' ? electronPath : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9483;
const dataDir = path.join(os.tmpdir(), `bili-interactions-e2e-${Date.now()}`);

const env = { ...process.env, BILI_LISTEN_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.text + ' :: ' + (m.params.exceptionDetails?.exception?.description || ''));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '').slice(0, 200) };
    return r.result.value;
  }
  async click(expr) {
    const pos = await this.eval(`(()=>{const e=${expr}; if(!e) return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    if (!pos) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    return true;
  }
  close() { try { this.ws.close(); } catch {} }
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`PASS  ${n}${d ? '  — ' + d : ''}`); } else { fail++; console.log(`FAIL  ${n}${d ? '  — ' + d : ''}`); } };

function launch() {
  return spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--hidden', '--mute-audio', '?mute=1'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function stopAll() {
  try {
    require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | Stop-Process -Force -ErrorAction SilentlyContinue`],
      { stdio: 'ignore' });
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
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  return cdp;
}

(async () => {
  let cdp = null, child = null;
  try {
    stopAll();
    fs.mkdirSync(dataDir, { recursive: true });
    // 空登录态：写接口在主进程直接 -101 拒绝，绝不发真实请求 / 花真币
    fs.writeFileSync(path.join(dataDir, 'bili-listen-config.json'), JSON.stringify({ cookie: '', user: null, theme: 'dark' }, null, 2), 'utf8');
    console.log(`[e2e] 临时数据目录：${dataDir}\n`);

    child = launch();
    cdp = await connect(child);
    await sleep(2500);

    // ---------- 1. 注入一个「正在播放」态，让互动菜单有目标 ----------
    const seeded = await cdp.eval(`(()=>{
      if(!window.__bili) return false;
      window.__bili.store.set({ playing: { bvid: 'BV1GJ411x7h7', cid: 137649199, title: 'e2e 视频', author: 'e2e UP', cover: '' }, nowPlayingOpen: true });
      return true;
    })()`);
    check('1. 注入播放态并展开全屏页', seeded === true);
    await sleep(600);

    // ---------- 2. 互动入口存在 ----------
    const hasBtn = await cdp.eval(`!!document.querySelector('#np-action-btn')`);
    check('2. 互动入口按钮存在', hasBtn === true);

    // ---------- 3. 一级菜单三项 ----------
    await cdp.click(`document.querySelector('#np-action-btn')`);
    await sleep(400);
    const level1 = await cdp.eval(`(()=>{const m=document.querySelector('.action-menu');if(!m)return null;return [...m.querySelectorAll('.action-item-label')].map(x=>x.textContent);})()`);
    check('3. 一级菜单含投币/收藏/关注', Array.isArray(level1) && level1.length === 3 && level1[0] === '投币' && level1[1] === '收藏' && level1[2].startsWith('关注'), JSON.stringify(level1));

    // ---------- 4. 投币二级菜单 ----------
    await cdp.click(`document.querySelector('.action-item')`);
    await sleep(400);
    const coinOpts = await cdp.eval(`(()=>{const m=document.querySelector('.action-menu');if(!m)return null;return [...m.querySelectorAll('.action-option')].map(x=>x.textContent.trim());})()`);
    check('4. 投币二级菜单含 1/2 币', Array.isArray(coinOpts) && coinOpts.some((t) => /投 1 币/.test(t)) && coinOpts.some((t) => /投 2 币/.test(t)), JSON.stringify(coinOpts));
    const hasBack = await cdp.eval(`!!document.querySelector('.action-sub-back')`);
    check('5. 二级菜单有返回按钮', hasBack === true);

    // ---------- 5. 点「投 1 币」→ 未登录失败反馈（不发真实请求） ----------
    await cdp.click(`[...document.querySelectorAll('.action-option')].find(x=>/投 1 币/.test(x.textContent))`);
    await sleep(900);
    const coinFeedback = await cdp.eval(`(()=>{const tip=document.querySelector('.action-menu-tip');const t=document.querySelector('.toast.error');return {tip:tip?tip.textContent:'',toast:t?t.textContent:'',hasErrClass:tip?tip.classList.contains('err'):false};})()`);
    check('6. 未登录投币给出失败反馈', /未登录|登录/.test(coinFeedback.tip + coinFeedback.toast), JSON.stringify(coinFeedback));
    check('7. 失败态有错误样式', coinFeedback.hasErrClass === true);

    // ---------- 6. 返回一级菜单 ----------
    await cdp.click(`document.querySelector('.action-sub-back')`);
    await sleep(400);
    const backL1 = await cdp.eval(`(()=>{const m=document.querySelector('.action-menu');return m?[...m.querySelectorAll('.action-item-label')].map(x=>x.textContent):null;})()`);
    check('8. 返回按钮回到一级菜单', Array.isArray(backL1) && backL1.length === 3, JSON.stringify(backL1));

    // ---------- 7. 收藏二级菜单（收藏夹读取失败 → 降级默认夹按钮） ----------
    await cdp.click(`[...document.querySelectorAll('.action-item')][1]`);
    await sleep(1600);
    const favUi = await cdp.eval(`(()=>{const m=document.querySelector('.action-menu');if(!m)return null;return {tip:(m.querySelector('.action-menu-tip')||{}).textContent||'',apply:!!m.querySelector('.action-apply'),opts:m.querySelectorAll('.action-option').length};})()`);
    check('9. 收藏二级菜单可用（降级默认夹）', !!favUi && favUi.apply === true, JSON.stringify(favUi));

    // ---------- 8. 关注二级菜单 ----------
    await cdp.click(`document.querySelector('.action-sub-back')`);
    await sleep(300);
    await cdp.click(`[...document.querySelectorAll('.action-item')][2]`);
    await sleep(500);
    const followUi = await cdp.eval(`(()=>{const m=document.querySelector('.action-menu');if(!m)return null;return {opts:[...m.querySelectorAll('.action-option')].map(x=>x.textContent.trim()),tip:(m.querySelector('.action-menu-tip')||{}).textContent||''};})()`);
    check('10. 关注二级菜单含关注/取关或明确提示', !!followUi && (followUi.opts.some((t) => /关注/.test(t)) || /作者信息|重新点开/.test(followUi.tip)), JSON.stringify(followUi));

    // ---------- 9. ESC 关闭菜单 ----------
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
    const menuGone = await cdp.eval(`!document.querySelector('.action-menu')`);
    check('11. ESC 关闭互动菜单', menuGone === true);

    // ---------- 10. 字幕链路结构化状态 ----------
    const lyric = await cdp.eval(`(()=>{const s=window.__bili?.store?.get?.()||{};return {status:'lyricsStatus' in s, message:'lyricsMessage' in s, value:s.lyricsStatus, msg:s.lyricsMessage};})()`);
    check('12. 字幕状态结构化（不再静默空数组）', lyric.status === true && lyric.message === true, JSON.stringify(lyric));

    // 真实调用一次字幕 IPC：未登录时应返回结构化 reason 而不是抛异常
    const subRes = await cdp.eval(`(async()=>{try{const r=await window.bili.subtitle({bvid:'BV1GJ411x7h7',cid:137649199});return {ok:r&&r.ok,reason:r&&r.data&&r.data.reason,hasLines:!!(r&&r.data&&r.data.lines)};}catch(e){return {err:String(e)};}})()`);
    check('13. 字幕 IPC 返回结构化 reason', !!subRes && subRes.ok === true && typeof subRes.reason === 'string' && subRes.hasLines === true, JSON.stringify(subRes));

    // ---------- 11. 无渲染层异常 ----------
    check('14. 无控制台异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | ') || 'clean');
  } catch (e) {
    console.error('ERR', e.stack || e.message || e);
    fail++;
  } finally {
    if (cdp) cdp.close();
    if (child) { try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    stopAll();
    await sleep(600);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n[verify-interactions-e2e] ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
