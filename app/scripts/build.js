'use strict';
/**
 * 打包脚本：electron-builder → Windows 安装包
 *
 * 产物（都在 ..\dist 下）：
 *   BiliListen-Setup-<版本>.exe   安装包：下一步 → 下一步 → 桌面图标 → 打开即用
 *   BiliListen-win32-x64\         免安装目录版：整个文件夹拷走也能跑
 *   latest.yml                    自动更新用的元数据（暂时没接更新服务器）
 *
 * 用法：node scripts\build.js
 *      node scripts\build.js --dir     只出目录版，不压安装包（快，验收用）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, '..', 'dist');
const unpackedDir = path.join(distDir, 'win-unpacked');
const portableDir = path.join(distDir, 'BiliListen-win32-x64');
const iconPath = path.join(root, 'build', 'icon.ico');
const dirOnly = process.argv.includes('--dir');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** dist 里正在运行的本程序会锁住 exe，先结束掉（只动 dist 目录里的进程） */
function stopRunningFromDist() {
  try {
    const ps = [
      '-NoProfile',
      '-Command',
      `Get-Process | Where-Object { $_.Path -like '${distDir.replace(/'/g, "''")}\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ];
    execFileSync('powershell', ps, { stdio: 'ignore' });
  } catch {}
}

if (!fs.existsSync(iconPath)) {
  console.error('[build] 缺少 build/icon.ico，先跑：npx electron scripts/make-icon.js');
  process.exit(1);
}

console.log('[build] 清理 dist（并结束里面正在运行的旧版本）');
stopRunningFromDist();
rmrf(distDir);
fs.mkdirSync(distDir, { recursive: true });

// 注意：本机全局有 ELECTRON_RUN_AS_NODE=1，不清掉会让 electron 退化成纯 node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const args = [cli, '--win', ...(dirOnly ? ['dir'] : ['nsis']), '--x64'];
console.log(`[build] electron-builder ${args.slice(1).join(' ')}`);
execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });

// electron-builder 输出目录固定叫 win-unpacked；改成产品名，也方便老脚本/用户认
if (fs.existsSync(unpackedDir)) {
  fs.renameSync(unpackedDir, portableDir);
}

const exePath = path.join(portableDir, 'BiliListen.exe');
if (!fs.existsSync(exePath)) {
  console.error('[build] 没有生成 BiliListen.exe，检查 electron-builder 输出');
  process.exit(1);
}

fs.writeFileSync(
  path.join(portableDir, '启动 BiliListen.bat'),
  '@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\ncd /d "%~dp0"\r\nstart "" "BiliListen.exe"\r\n',
  'utf8',
);

fs.writeFileSync(
  path.join(portableDir, 'README.txt'),
  [
    'BiliListen · 哔哩哔哩听视频桌面版',
    '================================',
    '',
    '这是免安装目录版：双击 BiliListen.exe 即可运行，整个文件夹可以拷到 U 盘。',
    '想要「装到本机 + 桌面图标」，用同目录上一层的 BiliListen-Setup-*.exe。',
    '',
    '功能：',
    '  - 纯音频播放 B 站视频（不拉视频流，省流量）',
    '  - 后台/托盘常驻播放，支持全局媒体键',
    '  - 播放队列、播放模式（顺序/循环/单曲/随机）',
    '  - 倍速 0.5x - 2.0x',
    '  - 定时关闭',
    '  - 搜索 / 排行榜 / 收藏夹 / 最近在听',
    '  - 关掉再开：队列、播放进度、登录态都还在',
    '',
    `数据目录：%APPDATA%\\BiliListen\\bili-listen-config.json`,
    '',
    '逆向自 B 站 Android 客户端 8.91.1 的 music_podcast 模块。',
  ].join('\r\n'),
  'utf8',
);

const mb = (p) => {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size / 1048576;
  return fs.readdirSync(p, { withFileTypes: true }).reduce(
    (n, e) => n + mb(path.join(p, e.name)),
    0,
  );
};

console.log('');
console.log(`[build] 目录版：${portableDir}  (${mb(portableDir).toFixed(0)} MB)`);
for (const f of fs.readdirSync(distDir)) {
  if (!f.endsWith('.exe')) continue;
  console.log(`[build] 安装包：${path.join(distDir, f)}  (${mb(path.join(distDir, f)).toFixed(0)} MB)`);
}
