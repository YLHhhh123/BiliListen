'use strict';
/**
 * verify-cookie-import.js —— 校验「粘贴 Cookie」这条免手机登录路径
 *
 * 覆盖：
 *  1) 各种粘贴形态的解析（裸 SESSDATA / Cookie 头 / 带 Cookie: 前缀 / 多行）
 *  2) document.cookie 那种没有 SESSDATA 的串必须被识别出来并给明确错误
 *  3) 脏输入不会把控制字符塞进请求头
 *  4) 真实接口：假 SESSDATA 必须判为未登录，真 SESSDATA 必须判为已登录（有则测）
 *
 * 用法：node scripts/verify-cookie-import.js
 */
const assert = require('assert');
const path = require('path');

const { parseCookieInput, completeCookie } = require(path.join(__dirname, '..', 'electron', 'services', 'cookie-import'));
const bili = require(path.join(__dirname, '..', 'electron', 'services', 'bili'));

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      '));
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + (e.message || e).split('\n').join('\n      '));
  }
}

const FAKE_SESSDATA = '6f1d2c3b%2C1799999999%2C4a5e6f%2A91';

console.log('\n[1] 解析：粘贴形态');
ok('裸 SESSDATA 值 → 自动补成 SESSDATA=...', () => {
  const r = parseCookieInput(FAKE_SESSDATA);
  assert.strictEqual(r.cookie, 'SESSDATA=' + FAKE_SESSDATA);
  assert.strictEqual(r.hasSessdata, true);
  assert.strictEqual(r.bare, true);
});

ok('裸值带首尾空格/引号也能吃掉', () => {
  const r = parseCookieInput('  "' + FAKE_SESSDATA + '"  ');
  assert.strictEqual(r.cookie, 'SESSDATA=' + FAKE_SESSDATA);
});

ok('整行 Cookie（含 Cookie: 前缀）', () => {
  const r = parseCookieInput('Cookie: SESSDATA=' + FAKE_SESSDATA + '; bili_jct=deadbeef; DedeUserID=123456');
  assert.strictEqual(r.hasSessdata, true);
  assert.strictEqual(r.bare, false);
  assert.deepStrictEqual(r.names, ['SESSDATA', 'bili_jct', 'DedeUserID']);
  assert.ok(r.cookie.includes('bili_jct=deadbeef'));
});

ok('多行 / 分号混排 / 重复字段去重', () => {
  const r = parseCookieInput('SESSDATA=' + FAKE_SESSDATA + ';\nbuvid3=abc==\n;SESSDATA=dup; sid=xyz');
  assert.strictEqual(r.names.filter((n) => n === 'SESSDATA').length, 1);
  assert.deepStrictEqual(r.names, ['SESSDATA', 'buvid3', 'sid']);
  assert.ok(r.cookie.includes('buvid3=abc=='));
});

ok('没有等号的脏串被当成裸值而不是崩掉', () => {
  const r = parseCookieInput('abcdef123456');
  assert.strictEqual(r.cookie, 'SESSDATA=abcdef123456');
});

console.log('\n[2] 解析：错误输入');
ok('空输入 → EMPTY', () => {
  assert.throws(() => parseCookieInput(''), (e) => e.code === 'EMPTY');
  assert.throws(() => parseCookieInput('   '), (e) => e.code === 'EMPTY');
  assert.throws(() => parseCookieInput(null), (e) => e.code === 'EMPTY');
});

ok('document.cookie 那种串（无 SESSDATA）→ 解析成功但 hasSessdata=false', () => {
  const r = parseCookieInput(
    'buvid3=8F1A; b_nut=1700000000; CURRENT_FNVAL=4048; buvid4=ABC-123; rpdid=|(J~Rk)u~k|',
  );
  assert.strictEqual(r.hasSessdata, false);
  assert.ok(r.names.length >= 4);
});

ok('带空格的自由文本 → BAD_INPUT，不会拼进请求头', () => {
  assert.throws(() => parseCookieInput('我复制错了 这不是 cookie'), (e) => e.code === 'BAD_INPUT');
});

ok('控制字符 → BAD_INPUT', () => {
  assert.throws(() => parseCookieInput('a\u0000b'), (e) => e.code === 'BAD_INPUT');
});

ok('解析结果里不可能出现 CR/LF（防头注入）', () => {
  const r = parseCookieInput('SESSDATA=' + FAKE_SESSDATA + ';\r\nbili_jct=x; evil=1\r\nX-Injected: 1');
  assert.ok(!/[\r\n]/.test(r.cookie), 'cookie 串里混入了换行');
  assert.ok(!r.names.includes('X-Injected'), '把换行后的伪头当成了 cookie 字段');
});

console.log('\n[3] 落盘前补全 Cookie');
ok('只给 SESSDATA + nav 返回 mid → 自动补 DedeUserID', () => {
  const p = parseCookieInput(FAKE_SESSDATA);
  const c = completeCookie(p, { mid: 998877 });
  assert.strictEqual(c, 'SESSDATA=' + FAKE_SESSDATA + '; DedeUserID=998877');
});

ok('已经带了 DedeUserID → 不重复追加', () => {
  const p = parseCookieInput('SESSDATA=' + FAKE_SESSDATA + '; DedeUserID=111');
  const c = completeCookie(p, { mid: 998877 });
  assert.strictEqual(c.match(/DedeUserID/g).length, 1);
  assert.ok(c.includes('DedeUserID=111'));
});

ok('nav 没返回 mid → 原样返回，不造脏字段', () => {
  const p = parseCookieInput(FAKE_SESSDATA);
  assert.strictEqual(completeCookie(p, { mid: 0 }), 'SESSDATA=' + FAKE_SESSDATA);
});

console.log('\n[4] 真实接口：登录态判定');
(async () => {
  await okAsync('假 SESSDATA → isLogin=false（不能让假凭据过关）', async () => {
    const s = await bili.checkLogin({ cookie: 'SESSDATA=' + FAKE_SESSDATA });
    assert.strictEqual(s.isLogin, false);
  });

  await okAsync('空 cookie → isLogin=false，且返回结构完整', async () => {
    const s = await bili.checkLogin({ cookie: '' });
    assert.strictEqual(s.isLogin, false);
    assert.strictEqual(typeof s.code, 'number');
    assert.strictEqual(typeof s.message, 'string');
  });

  // 有真 cookie 时顺手验一遍正向链路
  const real = process.env.BILI_TEST_COOKIE;
  if (real) {
    await okAsync('真 SESSDATA（来自 BILI_TEST_COOKIE）→ isLogin=true', async () => {
      const s = await bili.checkLogin({ cookie: real });
      assert.strictEqual(s.isLogin, true, '真 cookie 没能登录');
      assert.ok(s.mid > 0);
    });
  } else {
    console.log('  · 跳过真 Cookie 正向用例（未设置 BILI_TEST_COOKIE）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
