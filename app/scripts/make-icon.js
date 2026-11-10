'use strict';
/**
 * 生成 Windows 应用图标：build/icon.svg → build/icon.ico
 *
 * 为什么要用 Electron 来画：机器上没有 sharp / ImageMagick，而 Electron 自带
 * Chromium，SVG 渲染 + capturePage 拿到的是和界面完全一致的光栅化结果。
 * ICO 里每个尺寸放一张 PNG（Vista 以后支持 PNG 压缩条目），16~256 全齐，
 * 任务栏、桌面、开始菜单、安装程序都能取到清晰的那一档。
 *
 * 用法：npx electron scripts/make-icon.js
 *      ICON_SIZES=32,256 npx electron scripts/make-icon.js   # 只出指定尺寸
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = (process.env.ICON_SIZES || '16,20,24,32,40,48,64,96,128,256')
  .split(',')
  .map((n) => parseInt(n, 10))
  .filter(Boolean);
const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'build', 'icon.svg');
const outIco = path.join(root, 'build', 'icon.ico');
const outPng = path.join(root, 'build', 'icon.png');
const tmpDir = path.join(root, 'build', '.tmp');

// 这台机器上 offscreen 模式的 GPU 进程会崩（exit 0xC0000409），
// 走「窗口摆到屏幕外 + 软渲染」这条路，稳定且不闪屏。
app.disableHardwareAcceleration();

function svgToHtml(svg, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svg}</body></html>`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 所有尺寸复用同一个窗口。
 * 每个尺寸新建窗口时，第二次 loadFile 会 ERR_FAILED —— 上一个窗口 destroy 后
 * 合成器还没收尾，重开就会出现加载失败。复用窗口最稳。
 */
async function renderAll(svg) {
  const biggest = Math.max(...SIZES);
  const win = new BrowserWindow({
    width: biggest,
    height: biggest,
    x: -4000,
    y: -4000,
    show: true,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });

  const out = [];
  for (const size of SIZES) {
    win.setContentSize(size, size);
    const htmlPath = path.join(tmpDir, 'icon.html');
    fs.writeFileSync(htmlPath, svgToHtml(svg, size), 'utf8');
    await win.loadFile(htmlPath);
    await wait(180);
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    const { width, height } = img.getSize();
    if (!png || png.length < 100) throw new Error(`尺寸 ${size} 渲染为空`);
    if (width !== size || height !== size) {
      throw new Error(`尺寸 ${size} 实际渲染为 ${width}x${height}`);
    }
    out.push({ size, png });
    console.log(`  · ${size}x${size}  ${png.length} B`);
  }
  win.destroy();
  return out;
}

/** 把多张 PNG 拼成 ICO（ICONDIR + ICONDIRENTRY + PNG 数据） */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach(({ size, png }, i) => {
    const b = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, b + 0); // 0 表示 256
    dir.writeUInt8(size >= 256 ? 0 : size, b + 1);
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // planes
    dir.writeUInt16LE(32, b + 6); // bpp
    dir.writeUInt32LE(png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const svg = fs.readFileSync(svgPath, 'utf8');
    const entries = await renderAll(svg);
    const png256 = entries.find((e) => e.size === 256);
    if (png256) fs.writeFileSync(outPng, png256.png);
    fs.writeFileSync(outIco, buildIco(entries));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[icon] 已生成 ${outIco}（${entries.length} 档尺寸）`);
    app.exit(0);
  } catch (e) {
    console.error('[icon] 失败', e.message || e);
    app.exit(1);
  }
});
