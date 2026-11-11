'use strict';
/**
 * 打包脚本：electron-builder → Windows 安装包
 *
 * 产物（都在 ..\dist 下）：
 *   BiliListen-Setup-<版本>.exe   安装包：下一步 → 下一步 → 桌面图标 → 打开即用
 *   BiliListen-win32-x64\         免安装目录版：整个文件夹拷走也能跑
 *   latest.yml                    自动更新用的元数据（暂时没接更新服务器）
 *
 * 代码签名：检测 ..\..\certs\codesign.pfx（自签名证书，node scripts\make-cert.js 生成）。
 *   有 → 目录版 exe 和安装包自动签名 + RFC3161 时间戳；
 *   没有 → 跳过签名，产物照常出（首装会触发 SmartScreen 提示，手动放行即可）。
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

// ---------- 代码签名 ----------
// 自签名 + 商业证书共用这一条路：以后买证书只换 PFX 文件，构建脚本不动。
const certsDir = path.join(root, '..', 'certs');
const pfxPath = path.join(certsDir, 'codesign.pfx');
const passPath = path.join(certsDir, 'codesign.pass.txt');
// electron-builder 会在封装 NSIS 前签应用文件，再签最终安装器并生成对应 blockmap。
// 不能在构建完成后再手工签安装器，否则 blockmap 会失效，安装器内的应用也仍是未签名版本。
const hasPfx = fs.existsSync(pfxPath);
const hasPass = fs.existsSync(passPath);
if (hasPfx !== hasPass) {
  console.error('[build] 代码签名配置不完整：codesign.pfx 与 codesign.pass.txt 必须同时存在。');
  process.exit(1);
}
const canSign = hasPfx && hasPass;

function hasPwsh() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 检查最终 PE 是否嵌入 Authenticode 签名，并确认签名者是本次 PFX。 */
function verifySignature(file) {
  if (!canSign) return;
  const pass = fs.readFileSync(passPath, 'utf8').trim();
  const escapedFile = file.replace(/'/g, "''");
  const escapedPfx = pfxPath.replace(/'/g, "''");
  const escapedPass = pass.replace(/'/g, "''");
  const ps = [
    '$ErrorActionPreference="Stop";',
    `$pwd=ConvertTo-SecureString '${escapedPass}' -AsPlainText -Force;`,
    `$cert=(Get-PfxData -FilePath '${escapedPfx}' -Password $pwd).EndEntityCertificates[0];`,
    `$sig=Get-AuthenticodeSignature -FilePath '${escapedFile}';`,
    'if(-not $sig.SignerCertificate){throw "文件没有 Authenticode 签名"};',
    'if($sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint){throw "签名证书指纹不匹配"};',
    'Write-Output ($sig.Status.ToString()+"|"+$sig.SignerCertificate.Subject+"|"+$sig.SignerCertificate.Thumbprint);',
  ].join(' ');
  try {
    const shell = hasPwsh() ? 'pwsh' : 'powershell';
    const info = execFileSync(shell, ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    console.log(`[build] 签名有效：${path.basename(file)}  ${info}`);
  } catch (e) {
    console.error('[build] 签名校验失败：' + path.basename(file));
    console.error((e.stderr || e.stdout || e.message).toString().slice(0, 800));
    process.exit(1);
  }
}

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
if (canSign) {
  // 只通过子进程环境把 PFX 交给 electron-builder，密码不会写进 package.json 或日志。
  // signingHashAlgorithms 固定为 SHA256，electron-builder 会给应用 exe / uninstaller / NSIS 安装器
  // 按正确顺序签名，并在签完最终安装器之后生成匹配的 blockmap。
  env.WIN_CSC_LINK = pfxPath;
  env.WIN_CSC_KEY_PASSWORD = fs.readFileSync(passPath, 'utf8').trim();
  env.CSC_LINK = pfxPath;
  env.CSC_KEY_PASSWORD = env.WIN_CSC_KEY_PASSWORD;
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
}

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
    '  - 自动生成播放目录（热门/榜单/收藏/相关推荐）',
    '  - 倍速列表选择 0.5x - 2.0x',
    '  - 定时关闭：播完当前暂停 + 定时暂停，可同时启用（先到为准）',
    '  - 搜索 / 排行榜 / 收藏夹 / 最近在听',
    '  - 关掉再开：队列、播放进度、登录态都还在',
    '',
    `数据目录：%APPDATA%\\BiliListen\\bili-listen-config.json`,
    '',
    '逆向自 B 站 Android 客户端 8.91.1 的 music_podcast 模块。',
  ].join('\r\n'),
  'utf8',
);

// ---------- 签名验收 ----------
if (canSign) {
  // 目录版已经在 NSIS 封装前由 electron-builder 签好；这里只验证，不再修改文件。
  verifySignature(exePath);
} else {
  console.log('[build] 未检测到签名证书（certs\\codesign.pfx），跳过签名。');
  console.log('[build] 生成自签名证书：node scripts\\make-cert.js');
}

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
  const exe = path.join(distDir, f);
  if (canSign) verifySignature(exe);
  console.log(`[build] 安装包：${exe}  (${mb(exe).toFixed(0)} MB)`);
}
