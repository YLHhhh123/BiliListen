'use strict';
/**
 * 启动器：清掉 ELECTRON_RUN_AS_NODE 后拉起 Electron。
 * 本机全局设置了该变量（=1），直接跑 electron.exe 会退化成纯 Node 进程，
 * require('electron') 拿到的是路径字符串而不是 app 对象。
 */
const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron');
const electronPath = typeof electron === 'string' ? electron : path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(__dirname, '..'), ...process.argv.slice(2)];
const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (e) => {
  console.error('[launch] failed:', e.message);
  process.exit(1);
});
