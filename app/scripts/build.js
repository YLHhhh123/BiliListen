'use strict';
/**
 * 打包脚本（不依赖 electron-builder，纯手工拼目录 + 复制）
 * 产物：dist/BiliListen-win32-x64/BiliListen.exe
 *
 * 用法：node scripts/build.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outRoot = path.join(root, '..', 'dist');
const appDir = path.join(outRoot, 'BiliListen-win32-x64');
const resourcesApp = path.join(appDir, 'resources', 'app');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

console.log('[build] 清理输出目录');
rmrf(outRoot);
fs.mkdirSync(appDir, { recursive: true });

console.log('[build] 复制 Electron 运行时');
copyDir(electronDist, appDir);

console.log('[build] 复制应用代码');
copyDir(path.join(root, 'electron'), path.join(resourcesApp, 'electron'));
copyDir(path.join(root, 'src'), path.join(resourcesApp, 'src'));
copyDir(path.join(root, 'assets'), path.join(resourcesApp, 'assets'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(resourcesApp, 'package.json'));

// 复制运行时依赖（qrcode 等；electron 本身是 devDependency 不需要）
console.log('[build] 复制运行时依赖');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies || {});

/** 递归复制一个包及其全部传递依赖 */
const copied = new Set();
function copyPackageWithDeps(name, depth = 0) {
  if (copied.has(name) || depth > 6) return;
  const src = path.join(root, 'node_modules', name);
  if (!fs.existsSync(src)) {
    console.warn('  ! 缺少依赖 ' + name);
    return;
  }
  copyDir(src, path.join(resourcesApp, 'node_modules', name));
  copied.add(name);
  console.log('  + ' + name);
  try {
    const p = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    for (const d of Object.keys({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) })) {
      copyPackageWithDeps(d, depth + 1);
    }
  } catch {}
}

if (runtimeDeps.length) {
  runtimeDeps.forEach((d) => copyPackageWithDeps(d));
} else {
  copyPackageWithDeps('qrcode');
}

// 精简：删掉不需要的多语言包（保留 zh-CN / en-US）
const localesDir = path.join(appDir, 'locales');
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (!/^(zh-CN|en-US)\.pak$/.test(f)) fs.rmSync(path.join(localesDir, f));
  }
}

// 重命名 exe
const electronExe = path.join(appDir, 'electron.exe');
const targetExe = path.join(appDir, 'BiliListen.exe');
if (fs.existsSync(electronExe)) fs.renameSync(electronExe, targetExe);

// 写启动器（清 ELECTRON_RUN_AS_NODE）
fs.writeFileSync(
  path.join(appDir, '启动 BiliListen.bat'),
  '@echo off\r\nset ELECTRON_RUN_AS_NODE=\r\ncd /d "%~dp0"\r\nstart "" "BiliListen.exe"\r\n',
  'utf8',
);

// 写 README
fs.writeFileSync(
  path.join(appDir, 'README.txt'),
  [
    'BiliListen · 哔哩哔哩听视频桌面版',
    '================================',
    '',
    '启动方式：双击「启动 BiliListen.bat」或 BiliListen.exe',
    '',
    '功能：',
    '  - 纯音频播放 B 站视频（不拉视频流，省流量）',
    '  - 后台/托盘常驻播放，支持全局媒体键',
    '  - 播放队列、播放模式（顺序/循环/单曲/随机）',
    '  - 倍速 0.75x - 2.0x',
    '  - 定时关闭',
    '  - 搜索 / 排行榜 / 收藏夹 / 最近在听',
    '',
    '配置文件：%APPDATA%\\bili-listen-desktop\\bili-listen-config.json',
    '',
    '逆向自 B 站 Android 客户端 8.91.1 的 music_podcast 模块。',
  ].join('\r\n'),
  'utf8',
);

const size = execFileSync('powershell', ['-NoProfile', '-Command', `"{0:N1}" -f ((Get-ChildItem -Recurse '${appDir}' | Measure-Object -Property Length -Sum).Sum/1MB)`], { encoding: 'utf8' }).trim();
console.log(`[build] 完成：${appDir}  (${size} MB)`);
