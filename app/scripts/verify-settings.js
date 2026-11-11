#!/usr/bin/env node
/**
 * 设置页 + 发现页 联合验收（CDP）
 * 用法：node scripts/verify-settings.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const electronPath = require('electron');
const exe = typeof electronPath === 'string' ? electronPath : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9476;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const child = spawn(exe, ['.', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--hidden', '--mute-audio'], {
    cwd: root, env, stdio: 'ignore', detached: false,
  });

  // 等 CDP 就绪
  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { list = await httpGet(`http://127.0.0.1:${PORT}/json/list`); if (list.length) break; } catch {}
  }
  if (!list || !list.length) { console.log('FAIL 启动超时'); child.kill(); process.exit(1); }

  const page = list.find((t) => t.type === 'page') || list[0];
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
  await sleep(3500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text, desc: r.exceptionDetails.exception?.description };
    return r.result.value;
  };

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
    else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
  };

  // 现在会记住「上次停在哪一页」，验收前先回发现页，保证起点一致
  await ev(`(async()=>{const b=document.querySelector('.sidebar-item[data-key="discover"]');if(b){b.click();await new Promise(r=>setTimeout(r,1500));}return true;})()`);

  // 1. 发现页骨架清理
  const d = await ev(`({skel:document.querySelectorAll('.skeleton-card').length,cards:document.querySelectorAll('.video-card').length,
    loaded:[...document.querySelectorAll('.card-cover img')].filter(i=>i.naturalWidth>0).length})`);
  check('发现页骨架卡已清除', d.skel === 0, `skel=${d.skel} cards=${d.cards} loaded=${d.loaded}`);
  check('发现页真卡片 >= 20', d.cards >= 20, `cards=${d.cards}`);
  check('首屏封面有加载', d.loaded > 0, `loaded=${d.loaded}`);

  // 2. 进入设置页
  await ev(`document.querySelector('.sidebar-item[data-key="settings"]').click()`);
  await sleep(1200);
  const s = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.setting-row')];
    const labels=rows.map(r=>(r.querySelector('.setting-label')||{}).textContent||'').filter(Boolean);
    const selects=[...document.querySelectorAll('.setting-row select')];
    const quality=selects.find(x=>[...x.options].some(o=>o.value==='30280'));
    const rate=selects.find(x=>[...x.options].some(o=>o.value==='0.5'));
    const chk=document.querySelector('input[type=checkbox]');
    return {labels,qualityOptions:quality?[...quality.options].map(o=>o.value):[],rateOptions:rate?[...rate.options].map(o=>Number(o.value)):[],
      qualityValue:quality?.value,rateValue:rate?.value,hasCheckbox:!!chk,chkChecked:chk?chk.checked:null};
  })()`);
  check('设置页有音质下拉', s.qualityOptions.length === 5, `options=${JSON.stringify(s.qualityOptions)} value=${s.qualityValue}`);
  check('设置页有 6 档倍速下拉',
    s.rateOptions.length === 6 && [0.5,0.75,1,1.25,1.5,2].every(v=>s.rateOptions.includes(v)),
    `value=${s.rateValue} options=${JSON.stringify(s.rateOptions)}`);
  check('设置页有托盘开关', s.hasCheckbox === true, `checked=${s.chkChecked}`);
  check('设置页行标签完整', s.labels.length >= 7, s.labels.join(' / '));

  // 3. 改音质 → 落盘
  await ev(`(()=>{const sel=[...document.querySelectorAll('.setting-row select')].find(x=>[...x.options].some(o=>o.value==='30280'));sel.value='30251';sel.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(700);
  const q = await ev(`window.bili.getAllConfig()`);
  check('音质改动已持久化', q && String(q.quality) === '30251', `quality=${q && q.quality}`);

  // 4. 改倍速 → 落盘 + playbar 同步
  await ev(`(()=>{const r=[...document.querySelectorAll('.setting-row select')].find(x=>[...x.options].some(o=>o.value==='0.5'));r.value='1.5';r.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(700);
  const r2 = await ev(`({cfg:null, badge:(document.getElementById('pb-rate')||{}).textContent||''})`);
  const c2 = await ev(`window.bili.getAllConfig()`);
  check('倍速改动已持久化', c2 && String(c2.rate) === '1.5' && r2.badge === '1.5x', `rate=${c2 && c2.rate} playbar=${r2.badge}`);

  // 5. 托盘开关 → 落盘
  await ev(`(()=>{const c=document.querySelector('input[type=checkbox]');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(700);
  const c3 = await ev(`window.bili.getAllConfig()`);
  check('托盘开关已持久化', c3 && c3.minimizeToTray === false, `minimizeToTray=${c3 && c3.minimizeToTray}`);

  // 还原配置，别留脏数据
  await ev(`window.bili.setConfig({quality:30280,rate:1.0,minimizeToTray:true})`);
  await sleep(400);

  // 6. 无 console error
  check('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');

  console.log(`\n[verify-settings] ${pass}/${pass + fail} 通过`);
  ws.close();
  child.kill();
  await sleep(800);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
