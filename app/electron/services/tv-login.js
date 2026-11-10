'use strict';
/**
 * B 站 TV 端扫码登录
 *
 * 逆向自手机版 APK 的登录模块（com.bilibili.account / passport），
 * 这套接口是 B 站给 TV/大屏端用的，专门为「在另一个设备上显示二维码」设计：
 *
 *   POST /x/passport-tv-login/qrcode/auth_code   → 拿 auth_code + 二维码 URL
 *   POST /x/passport-tv-login/qrcode/poll        → 轮询扫码状态
 *
 * 返回码：
 *   0      → 登录成功，data 里带 cookie_info.cookies[] 和 token_info
 *   86039  → 二维码尚未确认（未扫码 / 已扫未点确认）
 *   86038  → 二维码已失效
 *   86090  → 已扫码，等待用户在手机上确认
 *
 * 安全要点：
 *  - 走 passport 官方接口，等同 TV 客户端登录，不是抓 Web Cookie
 *  - appkey/appsec 是 B 站 TV 端的公开常量（逆向得出），签名 = md5(排序参数 + appsec)
 *  - 全程不接触用户密码
 */

const crypto = require('crypto');

const APPKEY = '4409e2ce8ffd12b8';
const APPSEC = '59b43e04ad6965f34319062b478f83dd';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** TV 端签名：参数按 key 排序 → urlencode → 拼 appsec → md5 */
function tvSign(params) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  return crypto.createHash('md5').update(sorted + APPSEC).digest('hex');
}

async function tvPost(path, params = {}) {
  const p = { ...params, appkey: APPKEY, ts: Math.round(Date.now() / 1000) };
  p.sign = tvSign(p);
  const body = new URLSearchParams(p).toString();
  const res = await fetch('https://passport.bilibili.com' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('登录接口返回非 JSON: ' + text.slice(0, 200));
  }
}

/** 申请一个登录二维码 */
async function createQrCode() {
  const r = await tvPost('/x/passport-tv-login/qrcode/auth_code', { local_id: '0' });
  if (r.code !== 0) throw new Error(r.message || `申请二维码失败 (${r.code})`);
  return {
    url: r.data.url,
    authCode: r.data.auth_code,
    expiresIn: 180, // B 站二维码 3 分钟有效
  };
}

/** 轮询扫码状态 */
async function pollQrCode(authCode) {
  if (!authCode) throw new Error('缺少 auth_code');
  const r = await tvPost('/x/passport-tv-login/qrcode/poll', { local_id: '0', auth_code: authCode });

  // 0 = 成功
  if (r.code === 0 && r.data) {
    const cookies = (r.data.cookie_info?.cookies || [])
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return {
      status: 'success',
      cookie: cookies,
      mid: r.data.mid,
      accessToken: r.data.access_token,
      refreshToken: r.data.refresh_token,
      expiresIn: r.data.expires_in,
    };
  }
  if (r.code === 86090) return { status: 'scanned' }; // 已扫码待确认
  if (r.code === 86038) return { status: 'expired' }; // 已失效
  if (r.code === 86039) return { status: 'waiting' }; // 未扫码
  // 其它码当错误
  return { status: 'error', message: r.message || `未知状态 ${r.code}`, code: r.code };
}

module.exports = { createQrCode, pollQrCode, tvPost, tvSign, APPKEY };
