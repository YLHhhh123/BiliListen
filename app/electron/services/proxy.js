'use strict';
/**
 * 本地音频代理
 *
 * 为什么要它：
 *  1) 音频 CDN（*.bilivideo.cn / *.hdslb.com）校验 Referer=www.bilibili.com，并且会校验 UA；
 *     直接把 URL 丢给 <audio> 会因为缺 Referer 被 403。
 *  2) 播放地址 90 分钟过期，代理层可以就地刷新，前端不用感知。
 *  3) 支持 Range 透传，拖动进度条才能秒响应。
 */
const http = require('http');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class AudioProxy {
  constructor() {
    this.server = null;
    this.port = 0;
    /** @type {Map<string, {url:string, backupUrls:string[], expireAt:number, mimeType:string}>} */
    this.entries = new Map();
    this.resolver = null; // async (key) => entry
  }

  setResolver(fn) {
    this.resolver = fn;
  }

  /** 注册一个可播放资源，返回本地 URL */
  async register(key, entry) {
    this.entries.set(key, entry);
    return this.urlFor(key);
  }

  urlFor(key) {
    return `http://127.0.0.1:${this.port}/audio/${encodeURIComponent(key)}`;
  }

  has(key) {
    return this.entries.has(key);
  }

  drop(key) {
    this.entries.delete(key);
  }

  async ensure(key) {
    let e = this.entries.get(key);
    if (e && e.expireAt && e.expireAt - Date.now() > 3 * 60 * 1000) return e;
    if (!this.resolver) throw new Error('audio proxy resolver not set');
    e = await this.resolver(key);
    if (!e) throw new Error('资源不存在');
    this.entries.set(key, e);
    return e;
  }

  async handle(req, res) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    let u;
    try {
      u = new URL(req.url, `http://127.0.0.1:${this.port}`);
    } catch {
      res.writeHead(400);
      return res.end('bad url');
    }
    if (!u.pathname.startsWith('/audio/') && !u.pathname.startsWith('/img')) {
      res.writeHead(404, cors);
      return res.end('not found');
    }

    // ---------- 图片代理：/img?u=<encoded url> ----------
    if (u.pathname === '/img') {
      const target = u.searchParams.get('u');
      if (!target) {
        res.writeHead(400, cors);
        return res.end('missing u');
      }
      try {
        const upstream = await fetch(target, {
          headers: {
            'User-Agent': UA,
            Referer: 'https://www.bilibili.com/',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          redirect: 'follow',
        });
        if (!upstream.ok) {
          res.writeHead(upstream.status, cors);
          return res.end('upstream ' + upstream.status);
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          ...cors,
          'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(502, cors);
        res.end('img proxy failed: ' + e.message);
      }
      return;
    }

    const key = decodeURIComponent(u.pathname.slice('/audio/'.length));
    let entry;
    try {
      entry = await this.ensure(key);
    } catch (e) {
      res.writeHead(502, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('resolve failed: ' + e.message);
    }

    const tryUrls = [entry.url, ...(entry.backupUrls || [])].filter(Boolean);
    const range = req.headers.range;
    let lastErr = null;
    for (const target of tryUrls) {
      try {
        const headers = {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Origin: 'https://www.bilibili.com',
          Accept: '*/*',
        };
        if (range) headers.Range = range;
        const upstream = await fetch(target, { headers, redirect: 'follow' });
        if (!upstream.ok && upstream.status !== 206) {
          lastErr = new Error('upstream ' + upstream.status);
          continue;
        }
        const outHeaders = {
          ...cors,
          'Content-Type': entry.mimeType || upstream.headers.get('content-type') || 'audio/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        };
        const cl = upstream.headers.get('content-length');
        if (cl) outHeaders['Content-Length'] = cl;
        const cr = upstream.headers.get('content-range');
        if (cr) outHeaders['Content-Range'] = cr;
        res.writeHead(upstream.status, outHeaders);
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.write(Buffer.from(value))) {
                await new Promise((r) => res.once('drain', r));
              }
            }
          } catch (e) {
            /* client aborted */
          } finally {
            res.end();
          }
        };
        req.on('close', () => {
          try {
            reader.cancel();
          } catch {}
        });
        await pump();
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    res.writeHead(502, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('all upstream failed: ' + (lastErr?.message || 'unknown'));
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          try {
            res.writeHead(500);
            res.end(String(e));
          } catch {}
        });
      });
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { AudioProxy };
