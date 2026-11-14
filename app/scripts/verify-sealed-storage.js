#!/usr/bin/env node
/**
 * verify-sealed-storage.js —— cookie 加密落盘（safeStorage 信封）验收
 *
 *  A) sealed-cookie 纯函数：信封生成 / 解回 / 兜底 / 坏数据防御
 *  B) ConfigStore 集成：磁盘上不出现明文 SESSDATA、重启能读回、
 *     旧版明文配置自动迁移、.bak 恢复链路也走解密
 *
 * 用法：node scripts/verify-sealed-storage.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sealCookieField, unsealCookieField, isSealedEnvelope } = require(path.join(
  __dirname,
  '..',
  'electron',
  'services',
  'sealed-cookie',
));
const { ConfigStore } = require(path.join(__dirname, '..', 'electron', 'services', 'config-store'));

const COOKIE = 'SESSDATA=6f1d2c3b%2C1799999999%2C4a5e6f%2A91; DedeUserID=998877; bili_jct=deadbeef';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}  — ${e.message}`);
  }
};

/** 测试用「加密」：前缀混淆（可逆、可断言），不依赖 electron */
const enc = (t) => Buffer.from('X' + t, 'utf8');
const dec = (b) => {
  const s = b.toString('utf8');
  if (!s.startsWith('X')) throw new Error('bad magic');
  return s.slice(1);
};

// ============ A. 纯函数 ============

ok('isSealedEnvelope 识别信封', () => {
  assert.strictEqual(isSealedEnvelope({ __sealed: 1, data: 'aGk=' }), true);
  assert.strictEqual(isSealedEnvelope('SESSDATA=x'), false);
  assert.strictEqual(isSealedEnvelope(null), false);
  assert.strictEqual(isSealedEnvelope({ data: 'aGk=' }), false, '没有 __sealed 标记不算信封');
  assert.strictEqual(isSealedEnvelope([1]), false);
});

ok('seal：明文 cookie → 加密信封（磁盘形态）', () => {
  const out = sealCookieField({ cookie: COOKIE, volume: 0.5 }, enc);
  assert.ok(isSealedEnvelope(out.cookie), 'cookie 应变成信封');
  assert.ok(!out.cookie.data.includes('SESSDATA'), 'base64 里不能直接看出明文');
  assert.strictEqual(out.volume, 0.5, '其余字段原样保留');
  assert.strictEqual(
    dec(Buffer.from(out.cookie.data, 'base64')),
    COOKIE,
    '信封数据应能解回原文',
  );
});

ok('seal：roundtrip 解回 == 原文（不改原对象）', () => {
  const src = { cookie: COOKIE, user: { mid: 1 } };
  const sealed = sealCookieField(src, enc);
  const back = unsealCookieField(sealed, dec);
  assert.strictEqual(back.cookie, COOKIE);
  assert.strictEqual(typeof src.cookie, 'string', 'seal 不得改写调用方对象');
  assert.strictEqual(sealed.user, back.user, 'user 引用保持');
});

ok('seal：加密器抛错 → 明文兜底（不丢登录态）', () => {
  const boom = () => {
    throw new Error('dpapi unavailable');
  };
  const out = sealCookieField({ cookie: COOKIE }, boom);
  assert.strictEqual(out.cookie, COOKIE, '兜底应保持明文，行为同旧版');
});

ok('seal：加密器返回 null / 空串 → 明文兜底', () => {
  assert.strictEqual(sealCookieField({ cookie: COOKIE }, () => null).cookie, COOKIE);
  assert.strictEqual(sealCookieField({ cookie: COOKIE }, () => Buffer.alloc(0)).cookie, COOKIE);
});

ok('seal：空 cookie / 非 cookie 数据 → 原样透传', () => {
  const empty = { cookie: '', volume: 1 };
  assert.strictEqual(sealCookieField(empty, enc), empty, '没有凭据就没什么可加密');
  const nocookie = { volume: 1 };
  assert.strictEqual(sealCookieField(nocookie, enc), nocookie);
});

ok('unseal：旧版明文 → 原样透传（触发自动迁移）', () => {
  const plain = { cookie: COOKIE, user: { mid: 7 } };
  const out = unsealCookieField(plain, dec);
  assert.strictEqual(out.cookie, COOKIE);
  assert.strictEqual(out.user.mid, 7);
});

ok('unseal：信封坏 base64 → cookie 清空、不崩', () => {
  const out = unsealCookieField({ cookie: { __sealed: 1, data: '!!!not-base64!!!' } }, dec);
  assert.strictEqual(out.cookie, '');
  assert.strictEqual(out.user, null);
});

ok('unseal：解密器抛错（换了系统用户）→ cookie 清空、不崩', () => {
  const out = unsealCookieField({ cookie: { __sealed: 1, data: Buffer.from('Y').toString('base64') } }, dec);
  assert.strictEqual(out.cookie, '');
  assert.strictEqual(out.user, null);
});

// ============ B. ConfigStore 集成 ============

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-sealed-'));
const cfgPath = path.join(tmp, 'config.json');
const codec = { encrypt: enc, decrypt: dec };

try {
  ok('ConfigStore：写入后磁盘无明文 SESSDATA', () => {
    const s = new ConfigStore(cfgPath, undefined, codec);
    s.load();
    s.set({ cookie: COOKIE, user: { mid: 3 }, volume: 0.9 });
    s.flush();
    const raw = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(!raw.includes('SESSDATA'), '明文出现在磁盘文件里！');
    assert.ok(!raw.includes('deadbeef'), 'bili_jct 明文出现在磁盘文件里！');
    const parsed = JSON.parse(raw);
    assert.ok(isSealedEnvelope(parsed.cookie), '磁盘上应是信封形态');
    assert.strictEqual(JSON.parse(raw).user.mid, 3, 'user 保持明文（公开信息）');
  });

  ok('ConfigStore：重新 load 能解回登录态', () => {
    const s2 = new ConfigStore(cfgPath, undefined, codec);
    const d = s2.load();
    assert.strictEqual(d.cookie, COOKIE);
    assert.strictEqual(d.user.mid, 3);
    assert.strictEqual(d.volume, 0.9);
  });

  ok('ConfigStore：旧版明文文件 → load 后磁盘已迁移成信封', () => {
    const p2 = path.join(tmp, 'legacy.json');
    fs.writeFileSync(
      p2,
      JSON.stringify({ cookie: COOKIE, user: { mid: 5 }, volume: 0.3 }, null, 2),
      'utf8',
    );
    const s = new ConfigStore(p2, undefined, codec);
    const d = s.load();
    assert.strictEqual(d.cookie, COOKIE, '内存里要立刻可用');
    const raw = fs.readFileSync(p2, 'utf8');
    assert.ok(!raw.includes('SESSDATA'), '迁移后磁盘不应再有明文');
    assert.ok(isSealedEnvelope(JSON.parse(raw).cookie));
  });

  ok('ConfigStore：主文件损坏 → .bak 解密恢复', () => {
    const p3 = path.join(tmp, 'broken.json');
    const s = new ConfigStore(p3, undefined, codec);
    s.load();
    s.set({ cookie: COOKIE, lastRoute: 'favorites' });
    s.flush();
    fs.copyFileSync(p3, p3 + '.bak');
    fs.writeFileSync(p3, '{corrupted!!', 'utf8'); // 模拟写坏
    const s2 = new ConfigStore(p3, undefined, codec);
    const d = s2.load();
    assert.strictEqual(d.cookie, COOKIE, '.bak 恢复后要能解密');
    assert.strictEqual(d.lastRoute, 'favorites');
  });

  ok('ConfigStore：解密失败 → 视为未登录（cookie 空串），其余配置保留', () => {
    const p4 = path.join(tmp, 'foreign.json');
    // 用另一把「钥匙」写的信封（模拟换了系统用户）
    const foreignEnc = (t) => Buffer.from('Y' + t, 'utf8');
    const s = new ConfigStore(p4, undefined, { encrypt: foreignEnc, decrypt: dec });
    s.load();
    s.set({ cookie: COOKIE, theme: 'light' });
    s.flush();
    const s2 = new ConfigStore(p4, undefined, codec);
    const d = s2.load();
    assert.strictEqual(d.cookie, '', '解不开就当未登录');
    assert.strictEqual(d.theme, 'light', '其它配置不受影响');
  });

  ok('ConfigStore：无 codec（向后兼容）→ 明文行为同旧版', () => {
    const p5 = path.join(tmp, 'plain.json');
    const s = new ConfigStore(p5);
    s.load();
    s.set({ cookie: COOKIE });
    s.flush();
    const raw = fs.readFileSync(p5, 'utf8');
    assert.ok(raw.includes('SESSDATA'), '无 codec 时应保持旧版明文行为');
    const s2 = new ConfigStore(p5);
    assert.strictEqual(s2.load().cookie, COOKIE);
  });
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n[verify-sealed-storage] ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
