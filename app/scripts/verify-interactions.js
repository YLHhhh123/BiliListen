#!/usr/bin/env node
/**
 * verify-interactions.js —— v1.1.2 单元测试
 *
 *  A) 字幕链路：wbi/v2 主路径 / player/v2 回退 / view 兜底 / 结构化 reason
 *  B) 写操作：csrf 解析 / 缺登录 / 缺 csrf / 业务错误码映射 / 请求体正确性
 *
 * 用 global.fetch 打桩，不发真实网络请求、不碰真实登录态。
 * 用法：node scripts/verify-interactions.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

const bili = require(path.join(__dirname, '..', 'electron', 'services', 'bili'));

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('该用例应同步返回，改用 await 版本');
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}  — ${e.message}`);
  }
};
const okAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}  — ${e.message}`); }
};

/** 安装 fetch 打桩：handler(url, init) -> {status, json(object), raw(string)} */
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const r = await handler(String(url), init);
    calls.push({ url: String(url), init });
    const status = r.status || 200;
    const text = r.raw !== undefined ? r.raw : JSON.stringify(r.json === undefined ? {} : r.json);
    return {
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: { getSetCookie: () => r.setCookie || [] },
    };
  };
  return calls;
}
const realFetch = global.fetch;
const restoreFetch = () => { global.fetch = realFetch; };

const COOKIE = 'SESSDATA=abc%2C1799999999%2Cxyz%2A91; DedeUserID=12345; bili_jct=csrf-token-7788';

(async () => {
  // ================= A. csrf / 错误码映射（纯函数） =================
  ok('pickCsrf 从标准 Cookie 取 bili_jct', () => {
    assert.strictEqual(bili.pickCsrf(COOKIE), 'csrf-token-7788');
  });
  ok('pickCsrf 支持对象形态 cookie', () => {
    assert.strictEqual(bili.pickCsrf({ SESSDATA: 'a', bili_jct: 'obj-csrf' }), 'obj-csrf');
  });
  ok('pickCsrf 缺失返回空', () => {
    assert.strictEqual(bili.pickCsrf('SESSDATA=abc; DedeUserID=1'), '');
  });
  ok('pickCsrf 支持 URL 编码值', () => {
    assert.strictEqual(bili.pickCsrf('bili_jct=a%20b'), 'a b');
  });
  ok('pickCsrf 空输入安全', () => {
    assert.strictEqual(bili.pickCsrf(''), '');
    assert.strictEqual(bili.pickCsrf(null), '');
  });

  // ================= B. actionPost =================
  const postCases = [];
  mockFetch((url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body).entries());
    postCases.push({ url, headers: init.headers, body });
    return { json: { code: 0, message: '0', data: {} } };
  });

  await okAsync('actionPost 自动带 csrf + Cookie + POST', async () => {
    postCases.length = 0;
    await bili.actionPost('https://api.bilibili.com/x/test', { fid: 9 }, { cookie: COOKIE });
    const c = postCases[0];
    assert.strictEqual(c.body.csrf, 'csrf-token-7788');
    assert.strictEqual(c.body.fid, '9');
    assert.ok(String(c.headers.Cookie).includes('SESSDATA='));
    assert.ok(String(c.headers['Content-Type']).includes('application/x-www-form-urlencoded'));
  });

  await okAsync('actionPost 未登录抛 -101', async () => {
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: '' }),
      (e) => e.code === -101 && e.reason === 'need_login',
    );
  });

  await okAsync('actionPost 缺 bili_jct 抛 NEED_CSRF', async () => {
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: 'SESSDATA=only' }),
      (e) => e.code === 'NEED_CSRF' && e.reason === 'need_csrf',
    );
  });

  await okAsync('actionPost 业务码 -101 映射 need_login', async () => {
    mockFetch(() => ({ json: { code: -101, message: '账号未登录' } }));
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: COOKIE }),
      (e) => e.code === -101 && e.reason === 'need_login' && /未登录/.test(e.message),
    );
  });

  await okAsync('actionPost 风控码 -412 映射 risk', async () => {
    mockFetch(() => ({ json: { code: -412, message: '请求被拦截' } }));
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: COOKIE }),
      (e) => e.code === -412 && e.reason === 'risk',
    );
  });

  await okAsync('actionPost 限流码 -509 映射 rate_limited', async () => {
    mockFetch(() => ({ json: { code: -509, message: '请求过于频繁' } }));
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: COOKIE }),
      (e) => e.code === -509 && e.reason === 'rate_limited',
    );
  });

  await okAsync('actionPost 重复投币 34005 给人话', async () => {
    mockFetch(() => ({ json: { code: 34005, message: 'already' } }));
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: COOKIE }),
      (e) => e.code === 34005 && /已经投过币/.test(e.message),
    );
  });

  await okAsync('actionPost 非 JSON 响应报错', async () => {
    mockFetch(() => ({ raw: '<html>blocked</html>' }));
    await assert.rejects(
      () => bili.actionPost('https://api.bilibili.com/x/test', {}, { cookie: COOKIE }),
      (e) => /非 JSON/.test(e.message),
    );
  });

  // ================= C. 三个业务写接口 =================
  await okAsync('coinVideo 只允许 1/2 币', async () => {
    await assert.rejects(() => bili.coinVideo({ bvid: 'BV1', count: 3 }, { cookie: COOKIE }), /1 或 2/);
    await assert.rejects(() => bili.coinVideo({ bvid: 'BV1', count: 0 }, { cookie: COOKIE }), /1 或 2/);
  });

  await okAsync('coinVideo 请求体 multiply/csrf 正确', async () => {
    const calls = mockFetch((url, init) => {
      const body = Object.fromEntries(new URLSearchParams(init.body).entries());
      return { json: { code: 0, data: {} }, __body: body };
    });
    const r = await bili.coinVideo({ bvid: 'BV1xxx', count: 2 }, { cookie: COOKIE });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    const body = Object.fromEntries(new URLSearchParams(calls[0].init.body).entries());
    assert.strictEqual(body.multiply, '2');
    assert.strictEqual(body.bvid, 'BV1xxx');
    assert.strictEqual(body.csrf, 'csrf-token-7788');
    assert.ok(String(calls[0].url).includes('/x/web-interface/coin/add'));
  });

  await okAsync('coinVideo 缺 cookie 报未登录', async () => {
    mockFetch(() => ({ json: { code: 0, data: {} } }));
    await assert.rejects(() => bili.coinVideo({ bvid: 'BV1' }, { cookie: '' }), (e) => e.code === -101);
  });

  await okAsync('favoriteVideo 无 aid 时先用 view 补 rid', async () => {
    const urls = [];
    mockFetch((url, init) => {
      urls.push(String(url));
      if (String(url).includes('/x/web-interface/view')) return { json: { code: 0, data: { aid: 998877, cid: 1 } } };
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.favoriteVideo({ bvid: 'BV1xxx', mediaIds: [111, 222] }, { cookie: COOKIE });
    assert.strictEqual(r.ok, true);
    assert.ok(urls.some((u) => u.includes('/x/web-interface/view')));
    assert.ok(urls.some((u) => u.includes('/x/v3/fav/resource/deal')));
  });

  await okAsync('favoriteVideo 收藏夹 id 拼接 + 默认夹', async () => {
    let captured = null;
    mockFetch((url, init) => {
      if (String(url).includes('/fav/resource/deal')) {
        captured = Object.fromEntries(new URLSearchParams(init.body).entries());
        return { json: { code: 0, data: {} } };
      }
      return { json: { code: 0, data: { aid: 456 } } };
    });
    const r = await bili.favoriteVideo({ bvid: 'BV1', aid: 456, mediaIds: [11, 22] }, { cookie: COOKIE });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(captured.rid, '456');
    assert.strictEqual(captured.type, '2');
    assert.strictEqual(captured.add_media_ids, '11,22');
    assert.strictEqual(captured.del_media_ids, '');
    assert.strictEqual(captured.csrf, 'csrf-token-7788');
  });

  await okAsync('favoriteVideo 过滤非数字夹 id', async () => {
    let captured = null;
    mockFetch((url, init) => {
      captured = Object.fromEntries(new URLSearchParams(init.body).entries());
      return { json: { code: 0, data: {} } };
    });
    await bili.favoriteVideo({ bvid: 'BV1', aid: 1, mediaIds: ['abc', '12', '', 34] }, { cookie: COOKIE });
    assert.strictEqual(captured.add_media_ids, '12,34');
  });

  await okAsync('followAuthor 只支持关注/取关', async () => {
    await assert.rejects(() => bili.followAuthor({ mid: 1, act: 5 }, { cookie: COOKIE }), /不支持/);
    await assert.rejects(() => bili.followAuthor({ mid: 0 }, { cookie: COOKIE }), /mid/);
  });

  await okAsync('followAuthor 请求体 fid/act/re_src 正确', async () => {
    let captured = null;
    let url = '';
    mockFetch((u, init) => {
      url = String(u);
      captured = Object.fromEntries(new URLSearchParams(init.body).entries());
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.followAuthor({ mid: 888, act: 2 }, { cookie: COOKIE });
    assert.strictEqual(r.following, false);
    assert.ok(url.includes('/x/relation/modify'));
    assert.strictEqual(captured.fid, '888');
    assert.strictEqual(captured.act, '2');
    assert.strictEqual(captured.re_src, '12');
  });

  // ================= D. 字幕链路 =================
  // wbiGet 会先请求 nav 拿 wbi key
  const navBody = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b87ac.png' } } };
  const SUB_LINES = [{ from: 1, to: 2, content: '第一句' }, { from: 3, to: 4, content: '第二句' }];

  await okAsync('getSubtitle 主路径 wbi/v2 命中中文 AI 字幕', async () => {
    const urls = [];
    mockFetch((u) => {
      urls.push(String(u));
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/wbi/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [
          { lan: 'en-US', lan_doc: 'English', subtitle_url: 'https://x/en.json' },
          { lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: '//aisubtitle.hdslb.com/zh.json' },
        ] } } } };
      }
      if (String(u).includes('zh.json')) return { json: { body: SUB_LINES } };
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100, aid: 5 }, { cookie: COOKIE });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.lines.length, 2);
    assert.strictEqual(r.lines[0].content, '第一句');
    assert.strictEqual(r.lan, 'ai-zh', '应优先中文');
    assert.strictEqual(r.endpoint, 'wbi/v2');
    assert.ok(urls.some((u) => u.includes('w_rid=')), 'wbi/v2 必须带签名');
    assert.ok(urls.some((u) => u.includes('aisubtitle.hdslb.com')), '// 开头的 URL 应补 https');
  });

  await okAsync('getSubtitle wbi/v2 失败回退 player/v2', async () => {
    const urls = [];
    mockFetch((u) => {
      urls.push(String(u));
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/wbi/v2')) return { json: { code: -403, message: '访问权限不足' } };
      if (String(u).includes('/x/player/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-Hans', subtitle_url: 'https://x/zh.json' }] } } } };
      }
      if (String(u).includes('zh.json')) return { json: { body: SUB_LINES } };
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100 }, { cookie: COOKIE });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.endpoint, 'player/v2');
    assert.strictEqual(r.lines.length, 2);
  });

  await okAsync('getSubtitle 字幕列表空但 view 有轨 → reason=need_login', async () => {
    mockFetch((u) => {
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/v2') || String(u).includes('/x/player/wbi/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [] } } } };
      }
      if (String(u).includes('/x/web-interface/view')) {
        return { json: { code: 0, data: { aid: 1, cid: 1, subtitle: { list: [{ lan: 'zh-Hans' }] } } } };
      }
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100 }, { cookie: '' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.lines.length, 0);
    assert.strictEqual(r.reason, 'need_login');
  });

  await okAsync('getSubtitle 真无字幕 → reason=no_subtitle', async () => {
    mockFetch((u) => {
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/v2') || String(u).includes('/x/player/wbi/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [] } } } };
      }
      if (String(u).includes('/x/web-interface/view')) {
        return { json: { code: 0, data: { aid: 1, cid: 1 } } };
      }
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100 }, { cookie: COOKIE });
    assert.strictEqual(r.reason, 'no_subtitle');
  });

  await okAsync('getSubtitle 两个 player 端点都挂 → reason=player_failed', async () => {
    mockFetch((u) => {
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      return { json: { code: -412, message: '风控' } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100 }, { cookie: COOKIE });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'player_failed');
  });

  await okAsync('getSubtitle 字幕 json 下载失败 → reason=download_failed', async () => {
    mockFetch((u) => {
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/wbi/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://x/bad.json' }] } } } };
      }
      if (String(u).includes('bad.json')) return { status: 403, raw: 'forbidden' };
      return { json: { code: 0, data: {} } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100 }, { cookie: COOKIE });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'download_failed');
  });

  await okAsync('getSubtitle preferLan 显式指定语言优先', async () => {
    mockFetch((u) => {
      if (String(u).includes('/x/web-interface/nav')) return { json: navBody };
      if (String(u).includes('/x/player/wbi/v2')) {
        return { json: { code: 0, data: { subtitle: { subtitles: [
          { lan: 'zh-Hans', subtitle_url: 'https://x/zh.json' },
          { lan: 'en-US', subtitle_url: 'https://x/en.json' },
        ] } } } };
      }
      return { json: { body: SUB_LINES } };
    });
    const r = await bili.getSubtitle({ bvid: 'BV1', cid: 100, preferLan: 'en-US' }, { cookie: COOKIE });
    assert.strictEqual(r.lan, 'en-US');
  });

  await okAsync('getSubtitle 缺 bvid 直接报错', async () => {
    mockFetch(() => ({ json: { code: 0, data: {} } }));
    await assert.rejects(() => bili.getSubtitle({}, { cookie: COOKIE }), /bvid/);
  });

  restoreFetch();
  console.log(`\n[verify-interactions] ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
