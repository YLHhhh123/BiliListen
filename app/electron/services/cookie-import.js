'use strict';
/**
 * Cookie 输入解析（「粘贴 Cookie」登录用）
 *
 * 背景（拆包与实测结论）：
 *  SESSDATA 带 HttpOnly，浏览器里 document.cookie 永远读不到它。
 *  能拿到它的只有两条路，两条都靠 DevTools：
 *    A) Application(应用) → Storage → Cookies → https://www.bilibili.com → 复制 SESSDATA 的 Value
 *    B) Network → 任意请求 → Request Headers → Cookie 整行
 *
 * 本模块把这两种粘贴形态统一成一条可直接发给 B 站接口的 Cookie 头。
 */

/** Cookie 名字允许的字符（够覆盖 B 站全部字段） */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** 值里出现这些说明明显不是我们要的东西 */
const BAD_VALUE_RE = /[\u0000-\u001f\u007f]/;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * @param {string} raw 用户粘贴的任意形态
 * @returns {{cookie: string, names: string[], hasSessdata: boolean, bare: boolean}}
 */
function parseCookieInput(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) throw fail('EMPTY', '请先粘贴 SESSDATA 或 Cookie');

  // 去掉外层引号 / 反引号
  s = s.replace(/^["'`\s]+/, '').replace(/["'`\s]+$/, '');
  // 去掉 "Cookie:" 前缀（从 Network 面板整行复制时会带上）
  s = s.replace(/^cookie\s*:\s*/i, '').trim();
  if (!s) throw fail('EMPTY', '请先粘贴 SESSDATA 或 Cookie');

  // ---- 形态一：只粘贴了 SESSDATA 的值 ----
  // 判定：开头不是 `名字=` 的形状。SESSDATA 的值形如
  //   3f9c1a...%2C1760000000%2C7a3c...*91
  // 含 % 和 *，没有前导的 name=。
  if (!/^[A-Za-z0-9_-]+\s*=/.test(s)) {
    if (BAD_VALUE_RE.test(s)) throw fail('BAD_INPUT', '粘贴的内容里有控制字符，请重新复制');
    if (/\s/.test(s)) {
      throw fail(
        'BAD_INPUT',
        '这段内容看起来不是 Cookie 也不是 SESSDATA（里面有空格）。\n' +
          '请只复制 SESSDATA 的 Value，或整行 Cookie。',
      );
    }
    return { cookie: `SESSDATA=${s}`, names: ['SESSDATA'], hasSessdata: true, bare: true };
  }

  // ---- 形态二：整串 Cookie ----
  const parts = s.split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  const pairs = [];
  const seen = new Set();
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (!NAME_RE.test(name) || !value || BAD_VALUE_RE.test(value)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    pairs.push([name, value]);
  }
  if (!pairs.length) {
    throw fail('BAD_INPUT', '没能从这段内容里解析出任何 Cookie，请确认复制的是 Cookie 本身');
  }

  return {
    cookie: pairs.map(([k, v]) => `${k}=${v}`).join('; '),
    names: pairs.map(([k]) => k),
    hasSessdata: seen.has('SESSDATA'),
    bare: false,
  };
}

/** 取出某个字段的值（解析后的 cookie 串） */
function pick(cookie, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie || '');
  return m ? m[1] : '';
}

/**
 * 校验通过后补全落盘用的 cookie：
 * 用户往往只给了 SESSDATA，而收藏夹 / 历史接口还要 DedeUserID，用 nav 返回的 mid 补上。
 */
function completeCookie(parsed, status) {
  const cookie = (parsed && parsed.cookie) || '';
  if (!cookie) return '';
  const names = (parsed && parsed.names) || [];
  if (status && status.mid && !names.includes('DedeUserID')) {
    return `${cookie}; DedeUserID=${status.mid}`;
  }
  return cookie;
}

module.exports = { parseCookieInput, pick, completeCookie };
