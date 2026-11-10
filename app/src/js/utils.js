// ===== utils.js：公共工具函数 =====

/** 创建 DOM 元素的小工具，避免 innerHTML 拼接 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v); // 文本内容（不是 attribute）
    else if (k === 'html') node.innerHTML = v; // 仅用于内置图标 SVG，不要传用户数据
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.entries(v).forEach(([dk, dv]) => node.dataset[dk] = dv);
    } else if (k in node && typeof node[k] !== 'function') {
      try { node[k] = v; } catch { node.setAttribute(k, v); }
    } else {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child == null || child === false) continue;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

/** SVG 图标 helper */
export function svg(pathD, opts = {}) {
  const { size = 18, fill = 'currentColor', viewBox = '0 0 24 24' } = opts;
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', fill);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', pathD);
  s.appendChild(p);
  return s;
}

/** 秒数 → mm:ss 或 h:mm:ss */
export function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** 播放量格式化 */
export function fmtPlay(n) {
  if (n == null) return '';
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
  return String(n);
}

/** 发布时间 → 相对时间 */
export function fmtTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + '分钟前';
  if (diff < day) return Math.floor(diff / hour) + '小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + '天前';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 防抖 */
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 节流 */
export function throttle(fn, ms = 250) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

/** 二分查找字幕当前行 */
export function findLyricLine(lines, time) {
  if (!lines || lines.length === 0) return -1;
  let lo = 0, hi = lines.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].from <= time) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}
