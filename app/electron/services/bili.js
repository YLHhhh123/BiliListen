'use strict';
/**
 * B 站 Web API 封装（拆包逆向结论见 docs/REVERSE-NOTES.md）
 *
 * 逆向要点：
 *  - 手机版「听视频」= com.bilibili.music.podcast.*  模块
 *  - 播放入口 MusicPodcastResolver.requestPlayView() 走 gRPC-Moss: bilibili.app.listener.v1.Listener/PlayURL
 *    请求体 PlayURLReq{ item: PlayItem{ item_type, oid, sub_id[] }, player_args }
 *    响应 PlayURLResp{ item, playable, message, player_info: map<qn, PlayInfo> }
 *    PlayInfo{ qn, format, qn_type, play_url|play_dash, fnval, fnver, formats[], video_codecid, length, code, message, expire_time }
 *  - 桌面端用等价的 Web REST 接口 /x/player/wbi/playurl?fnval=4048 取 dash.audio[]，语义一致（同一套 playurl 网关）。
 *  - 音频流 CDN 需要 Referer: https://www.bilibili.com/ ；因此本进程内置本地代理转发。
 */

const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// 音质档位（dash.audio[].id）
const AUDIO_QUALITY = {
  30216: { id: 30216, name: '64K', desc: '流畅', codec: 'AAC' },
  30232: { id: 30232, name: '132K', desc: '标准', codec: 'AAC' },
  30280: { id: 30280, name: '192K', desc: '高', codec: 'AAC' },
  30250: { id: 30250, name: 'Dolby', desc: '杜比全景声', codec: 'EC3' },
  30251: { id: 30251, name: 'Hi-Res', desc: '无损', codec: 'FLAC' },
};

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((i) => orig[i])
    .join('')
    .slice(0, 32);
}

function stripUnsafe(v) {
  return String(v).replace(/[!'()*]/g, '');
}

let _wbiCache = { img: null, sub: null, ts: 0 };

async function getWbiKeys(force = false) {
  if (!force && _wbiCache.img && Date.now() - _wbiCache.ts < 30 * 60 * 1000) {
    return _wbiCache;
  }
  const j = await requestJson('https://api.bilibili.com/x/web-interface/nav', {}, { noWbi: true });
  const img = j?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0] || '';
  const sub = j?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0] || '';
  if (!img || !sub) throw new Error('获取 wbi key 失败');
  _wbiCache = { img, sub, ts: Date.now() };
  return _wbiCache;
}

/** 对 query 参数做 wbi 签名，返回完整 query string */
async function signedQuery(params = {}) {
  const { img, sub } = await getWbiKeys();
  const mixin = getMixinKey(img + sub);
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const val = p[k];
      if (val === undefined || val === null) return null;
      const arr = Array.isArray(val) ? val : [val];
      return arr
        .map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(stripUnsafe(v))}`)
        .join('&');
    })
    .filter(Boolean)
    .join('&');
  const w_rid = md5(query + mixin);
  return `${query}&w_rid=${w_rid}`;
}

function normalizeCookie(cookie) {
  if (!cookie) return '';
  if (typeof cookie === 'string') return cookie;
  if (Array.isArray(cookie)) {
    return cookie.map((c) => (typeof c === 'string' ? c : `${c.name}=${c.value}`)).join('; ');
  }
  if (typeof cookie === 'object') {
    return Object.entries(cookie)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return '';
}

async function requestJson(url, opts = {}, cfg = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...(opts.headers || {}),
  };
  if (opts.cookie) {
    const c = normalizeCookie(opts.cookie);
    if (c) headers.Cookie = c;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeout || 15000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

/** 统一带 wbi 的 GET */
async function wbiGet(path, params = {}, opts = {}) {
  const q = await signedQuery(params);
  const url = `${path}${path.includes('?') ? '&' : '?'}${q}`;
  const j = await requestJson(url, opts);
  if (j.code !== 0) {
    const err = new Error(j.message || `接口错误 ${j.code}`);
    err.code = j.code;
    throw err;
  }
  return j.data;
}

async function plainGet(path, params = {}, opts = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.append(k, v);
  }
  const url = `${path}${q.toString() ? (path.includes('?') ? '&' : '?') + q.toString() : ''}`;
  const j = await requestJson(url, opts);
  if (j.code !== 0) {
    const err = new Error(j.message || `接口错误 ${j.code}`);
    err.code = j.code;
    throw err;
  }
  return j.data;
}

// ---------------- 业务接口 ----------------

/** 搜索视频 */
async function search({ keyword, page = 1, pageSize = 20, order = '' } = {}, ctx = {}) {
  if (!keyword) throw new Error('缺少 keyword');
  const data = await wbiGet(
    'https://api.bilibili.com/x/web-interface/wbi/search/type',
    {
      search_type: 'video',
      keyword,
      page,
      page_size: pageSize,
      order,
      platform: 'pc',
    },
    { cookie: ctx.cookie },
  );
  const list = (data.result || []).map(normalizeSearchItem);
  return { items: list, total: data.numResults || data.total || list.length, page, pageSize };
}

function normalizeSearchItem(v) {
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: stripHtml(v.title),
    author: v.author,
    mid: v.mid,
    cover: normalizeUrl(v.pic),
    duration: parseDuration(v.duration),
    play: v.play,
    danmaku: v.video_review || v.danmaku,
    pubdate: v.pubdate ? v.pubdate * 1000 : null,
    desc: stripHtml(v.description || ''),
    type: 'video',
  };
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(u) {
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:/, 'https:');
}

function parseDuration(d) {
  if (typeof d === 'number') return d;
  if (!d) return 0;
  const parts = String(d).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** 视频详情（含分P） */
async function getVideo({ bvid }, ctx = {}) {
  if (!bvid) throw new Error('缺少 bvid');
  const d = await plainGet('https://api.bilibili.com/x/web-interface/view', { bvid }, { cookie: ctx.cookie });
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    cover: normalizeUrl(d.pic),
    desc: d.desc,
    duration: d.duration,
    pubdate: d.pubdate * 1000,
    owner: { mid: d.owner.mid, name: d.owner.name, face: normalizeUrl(d.owner.face) },
    stat: {
      view: d.stat.view,
      danmaku: d.stat.danmaku,
      reply: d.stat.reply,
      favorite: d.stat.favorite,
      coin: d.stat.coin,
      like: d.stat.like,
      share: d.stat.share,
    },
    cid: d.cid,
    pages: (d.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
  };
}

/** 相关推荐 */
async function getRelated({ bvid, pageSize = 20 }, ctx = {}) {
  const list = await plainGet(
    'https://api.bilibili.com/x/web-interface/archive/related',
    { bvid },
    { cookie: ctx.cookie },
  );
  return {
    items: (list || []).slice(0, pageSize).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      author: v.owner?.name || '',
      cover: normalizeUrl(v.pic),
      duration: v.duration,
      play: v.stat?.view || 0,
      pubdate: v.pubdate ? v.pubdate * 1000 : null,
      type: 'video',
    })),
  };
}

/** 排行榜（rid: 3=音乐, 0=全站, 4=游戏...） */
async function getRanking({ rid = 3, pageSize = 30 } = {}, ctx = {}) {
  const d = await plainGet(
    'https://api.bilibili.com/x/web-interface/ranking/v2',
    { rid, type: 'all' },
    { cookie: ctx.cookie },
  );
  return {
    items: (d.list || []).slice(0, pageSize).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      author: v.owner?.name || '',
      cover: normalizeUrl(v.pic),
      duration: v.duration,
      play: v.stat?.view || 0,
      pubdate: v.pubdate ? v.pubdate * 1000 : null,
      type: 'video',
    })),
  };
}

/** 综合热门 */
async function getPopular({ page = 1, pageSize = 30 } = {}, ctx = {}) {
  const d = await plainGet(
    'https://api.bilibili.com/x/web-interface/popular',
    { ps: pageSize, pn: page },
    { cookie: ctx.cookie },
  );
  return {
    items: (d.list || []).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      author: v.owner?.name || '',
      cover: normalizeUrl(v.pic),
      duration: v.duration,
      play: v.stat?.view || 0,
      pubdate: v.pubdate ? v.pubdate * 1000 : null,
      type: 'video',
    })),
    noMore: d.no_more,
  };
}

/**
 * 获取音频播放地址
 * @returns {{ url, backupUrls, expireAt, mimeType, codecs, bandwidth, duration, quality, qualities }}
 */
async function getPlayUrl({ bvid, cid, quality = 30280 }, ctx = {}) {
  if (!bvid) throw new Error('缺少 bvid');
  let useCid = cid;
  if (!useCid) {
    const v = await plainGet('https://api.bilibili.com/x/web-interface/view', { bvid }, { cookie: ctx.cookie });
    useCid = v.cid;
  }
  // fnval=4048 打开 dash + 杜比 + 无损 + 高码率
  const params = {
    bvid,
    cid: useCid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    platform: 'pc',
  };
  const d = await wbiGet('https://api.bilibili.com/x/player/wbi/playurl', params, {
    cookie: ctx.cookie,
    headers: { Referer: `https://www.bilibili.com/video/${bvid}/` },
  });
  const dash = d.dash;
  if (!dash || !dash.audio || !dash.audio.length) {
    // 回退 durl（老视频/番剧）
    if (d.durl && d.durl.length) {
      const u = d.durl[0];
      return {
        url: u.url,
        backupUrls: u.backup_url || [],
        expireAt: Date.now() + 90 * 60 * 1000,
        mimeType: 'audio/mp4',
        codecs: 'unknown',
        bandwidth: 0,
        duration: d.timelength ? Math.round(d.timelength / 1000) : 0,
        quality: null,
        qualities: [],
      };
    }
    throw new Error('没有可用的音频流（可能是付费/番剧/地区限制内容）');
  }
  const sorted = [...dash.audio].sort((a, b) => b.bandwidth - a.bandwidth);
  const qualities = sorted.map((a) => ({
    id: a.id,
    bandwidth: a.bandwidth,
    codecs: a.codecs,
    ...(AUDIO_QUALITY[a.id] || { name: `${Math.round(a.bandwidth / 1000)}K`, desc: '', codec: a.codecs }),
  }));
  const pick = sorted.find((a) => a.id === Number(quality)) || sorted.find((a) => a.id === 30280) || sorted[0];
  return {
    url: pick.baseUrl || pick.base_url,
    backupUrls: pick.backupUrl || pick.backup_url || [],
    expireAt: Date.now() + 90 * 60 * 1000,
    mimeType: pick.mimeType || pick.mime_type || 'audio/mp4',
    codecs: pick.codecs,
    bandwidth: pick.bandwidth,
    duration: dash.duration || 0,
    quality: pick.id,
    qualities,
  };
}

/** 校验 cookie 登录态 */
async function checkLogin({ cookie } = {}) {
  const j = await requestJson('https://api.bilibili.com/x/web-interface/nav', { cookie });
  const d = j.data || {};
  return {
    isLogin: !!d.isLogin,
    mid: d.mid || 0,
    uname: d.uname || '',
    face: d.face || '',
    vip: d.vipStatus === 1,
    level: d.level_info?.current_level ?? 0,
    // 留出原始返回，便于把「风控 / 过期」这类失败原因讲清楚
    code: j.code || 0,
    message: j.message || '',
  };
}

/** 收藏夹列表（需登录） */
async function getFavFolders({ cookie, mid } = {}) {
  if (!cookie) throw new Error('需要登录');
  const nav = await checkLogin({ cookie });
  const m = mid || nav.mid;
  if (!m) throw new Error('无法获取 mid');
  const d = await plainGet(
    'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    { up_mid: m },
    { cookie },
  );
  return {
    folders: (d.list || []).map((f) => ({
      id: f.id,
      title: f.title,
      mediaCount: f.media_count,
      cover: normalizeUrl(f.cover),
    })),
  };
}

/** 收藏夹内容（需登录） */
async function getFavList({ cookie, mediaId, page = 1, pageSize = 40 } = {}) {
  if (!cookie) throw new Error('需要登录');
  if (!mediaId) throw new Error('缺少 mediaId');
  const d = await plainGet(
    'https://api.bilibili.com/x/v3/fav/resource/list',
    { media_id: mediaId, pn: page, ps: pageSize, platform: 'web', keyword: '', order: 'mtime', type: 0, tid: 0 },
    { cookie },
  );
  return {
    items: (d.medias || [])
      .filter((m) => m.type === 2)
      .map((m) => ({
        bvid: m.bvid,
        aid: m.id,
        title: m.title,
        author: m.upper?.name || '',
        cover: normalizeUrl(m.cover),
        duration: m.duration,
        play: m.cnt_info?.play || 0,
        pubdate: m.pubtime ? m.pubtime * 1000 : null,
        type: 'video',
      })),
    hasMore: d.has_more,
  };
}

/**
 * 字幕（当作「歌词」用）
 * 手机版听视频的歌词来自字幕轨；桌面端用 player/v2 拿字幕列表再下载 json。
 * 返回 [{from,to,content}]，没有字幕时返回空数组（不报错）。
 */
async function getSubtitle({ bvid, cid } = {}, ctx = {}) {
  if (!bvid) throw new Error('缺少 bvid');
  let useCid = cid;
  if (!useCid) {
    const v = await plainGet('https://api.bilibili.com/x/web-interface/view', { bvid }, { cookie: ctx.cookie });
    useCid = v.cid;
  }
  let pv;
  try {
    pv = await plainGet('https://api.bilibili.com/x/player/v2', { bvid, cid: useCid }, { cookie: ctx.cookie });
  } catch {
    return { lines: [] };
  }
  const subs = pv?.subtitle?.subtitles || [];
  if (!subs.length) return { lines: [] };
  // 优先中文
  const pick =
    subs.find((s) => /^(zh|ai-zh)/i.test(s.lan || '')) || subs.find((s) => (s.lan || '').startsWith('ai-')) || subs[0];
  let url = normalizeUrl(pick.subtitle_url || '');
  if (url.startsWith('//')) url = 'https:' + url;
  if (!url) return { lines: [] };
  try {
    const j = await requestJson(url, { cookie: ctx.cookie, headers: { Referer: `https://www.bilibili.com/video/${bvid}/` } });
    return {
      lan: pick.lan,
      lanDoc: pick.lan_doc,
      lines: (j.body || []).map((b) => ({
        from: b.from,
        to: b.to,
        content: b.content,
      })),
    };
  } catch {
    return { lines: [] };
  }
}

/**
 * 解析用户粘贴的输入：BV 号 / av 号 / 完整链接 / b23.tv 短链
 * @returns {{bvid:string, cid?:number, page?:number}}
 */
async function resolveInput({ input } = {}, ctx = {}) {
  if (!input) throw new Error('请输入 BV 号或链接');
  let s = String(input).trim();

  // b23.tv 短链：跟随重定向
  if (/^https?:\/\/b23\.tv\//i.test(s)) {
    try {
      const r = await fetch(s, { redirect: 'follow', headers: { 'User-Agent': UA } });
      s = r.url || s;
    } catch (e) {
      throw new Error('短链解析失败: ' + e.message);
    }
  }

  // https://www.bilibili.com/video/BVxxx/?p=2
  const mBv = s.match(/BV[0-9A-Za-z]{10}/);
  if (mBv) {
    const mP = s.match(/[?&]p=(\d+)/);
    return { bvid: mBv[0], page: mP ? Number(mP[1]) : 1 };
  }
  // av 号
  const mAv = s.match(/av(\d+)/i);
  if (mAv) {
    const d = await plainGet('https://api.bilibili.com/x/web-interface/view', { aid: mAv[1] }, { cookie: ctx.cookie });
    const mP = s.match(/[?&]p=(\d+)/);
    return { bvid: d.bvid, page: mP ? Number(mP[1]) : 1 };
  }
  // 纯数字 = aid
  if (/^\d+$/.test(s)) {
    const d = await plainGet('https://api.bilibili.com/x/web-interface/view', { aid: s }, { cookie: ctx.cookie });
    return { bvid: d.bvid, page: 1 };
  }
  // 番剧 ep/ss
  const mEp = s.match(/ep(\d+)/i);
  if (mEp) return { epId: Number(mEp[1]), type: 'ogv' };
  const mSs = s.match(/ss(\d+)/i);
  if (mSs) return { seasonId: Number(mSs[1]), type: 'ogv' };

  throw new Error('无法识别的输入，请粘贴 BV 号或视频链接');
}

/** 稍后再看 / 历史（需登录） */
async function getHistory({ cookie, page = 1, pageSize = 20 } = {}) {
  if (!cookie) throw new Error('需要登录');
  const d = await plainGet(
    'https://api.bilibili.com/x/web-interface/history/cursor',
    { ps: pageSize, type: 'archive' },
    { cookie },
  );
  return {
    items: (d.list || []).map((v) => ({
      bvid: v.history?.bvid,
      aid: v.history?.oid,
      title: v.title,
      author: v.owner?.name || '',
      cover: normalizeUrl(v.cover),
      duration: v.duration,
      play: v.stat?.view || 0,
      pubdate: v.view_at ? v.view_at * 1000 : null,
      progress: v.progress,
      type: 'video',
    })),
    cursor: d.cursor,
  };
}

module.exports = {
  UA,
  AUDIO_QUALITY,
  search,
  getVideo,
  getRelated,
  getRanking,
  getPopular,
  getPlayUrl,
  getSubtitle,
  resolveInput,
  checkLogin,
  getFavFolders,
  getFavList,
  getHistory,
  requestJson,
  plainGet,
  wbiGet,
};
