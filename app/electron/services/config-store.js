'use strict';
/**
 * 配置 / 会话持久化
 *
 * 为什么不直接用 localStorage：
 *   - 登录 Cookie 必须由主进程保管（SESSDATA 是 HttpOnly，渲染进程拿不到）
 *   - 播放队列、播放断点要能在「托盘常驻」和「崩溃」之后还原
 *   - localStorage 跟着 Chromium 的 profile 走，清缓存就全没了，也不方便让用户备份
 *
 * 落盘策略（防丢数据）：
 *   1. 先写 config.json.tmp，再 rename 覆盖 —— rename 是原子操作，
 *      断电/强杀不会留下半截 JSON（写入中途崩溃最多丢这一次改动）。
 *   2. 覆盖前把旧文件复制成 config.json.bak。
 *   3. 读取时主文件解析失败自动回退 .bak，再失败就用默认值。
 *   4. 普通改动 150ms 防抖异步落盘；退出/SESSION 变更走同步 flush，
 *      保证「点退出 → 立刻再打开」也是新数据。
 */
const fs = require('fs');
const path = require('path');
const { sealCookieField, unsealCookieField } = require('./sealed-cookie');

const DEFAULTS = {
  // 播放器
  volume: 0.8,
  rate: 1.0,
  quality: 30280,
  playMode: 'order', // order | loop | single | shuffle
  sleepTimer: 0,
  showLyric: true,
  autoNext: true,
  // 界面
  theme: 'dark',
  minimizeToTray: true,
  windowBounds: null,
  lastRoute: 'discover',
  // 账号
  cookie: '',
  user: null,
  // 上次退出时的播放现场：{queue,currentIndex,playing,position,route,updatedAt}
  session: null,
  // 数据结构版本，以后改字段时用来做迁移
  schema: 1,
};

class ConfigStore {
  /**
   * @param {string} file  配置文件路径
   * @param {object} [defaults]
   * @param {{encrypt?:(t:string)=>Buffer|null, decrypt?:(b:Buffer)=>string}} [codec]
   *   cookie 字段的加解密回调（safeStorage/DPAPI）。不传 = 明文行为（单测用）。
   */
  constructor(file, defaults = DEFAULTS, codec = null) {
    this.file = file;
    this.bakFile = file + '.bak';
    this.tmpFile = file + '.tmp';
    this.defaults = defaults;
    this.codec = codec;
    this.data = { ...defaults };
    this.timer = null;
    this.dirty = false;
  }

  /** 读盘。主文件坏了回退 .bak，都坏了用默认值。 */
  load() {
    const readOne = (file) => {
      const obj = this._readJson(file);
      return obj ? unsealCookieField(obj, this.codec && this.codec.decrypt) : null;
    };
    const main = readOne(this.file);
    if (main) {
      this.data = { ...this.defaults, ...main };
    } else {
      const bak = readOne(this.bakFile);
      if (bak) {
        console.warn('[config] 主配置损坏，已从 .bak 恢复');
        this.data = { ...this.defaults, ...bak };
      } else {
        this.data = { ...this.defaults };
        return this.data;
      }
    }
    // 解密失败时 unsealCookieField 会把原始信封挂在临时字段上：
    // 摘出来单独保存，不进入内存配置（避免渲染层看到对象型 cookie），
    // 但后续任何落盘都原样写回，绝不把磁盘上唯一一份密文覆盖成空串。
    this._preserveEnvelope = this.data.__sealedCookieRaw || null;
    delete this.data.__sealedCookieRaw;
    // 安全迁移：仅在加密可用时把明文 cookie 改写成信封。
    // 密钥未就绪时 codec.encrypt 为 null，保持明文（等同旧版），等就绪后由主进程补做。
    if (typeof this.data.cookie === 'string' && this.data.cookie.trim() && this.codec && this.codec.encrypt) {
      this.dirty = true;
      this.flush();
      console.log('[config] cookie 已从明文迁移为加密信封');
    }
    return this.data;
  }

  _readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw || !raw.trim()) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      return obj;
    } catch (e) {
      console.warn('[config] 读取失败', file, e.message);
      return null;
    }
  }

  get() {
    return this.data;
  }

  /** 合并写入（内存立即生效，磁盘防抖） */
  set(patch = {}) {
    if (!patch || typeof patch !== 'object') return this.data;
    this.data = { ...this.data, ...patch };
    this.dirty = true;
    this._schedule();
    return this.data;
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._write();
    }, 150);
    // 不要因为这个定时器把进程吊住
    if (this.timer.unref) this.timer.unref();
  }

  /** 立即同步落盘（退出、崩溃恢复点、会话保存时用） */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._write();
  }

  _write() {
    if (!this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // cookie 字段加密成信封再落盘；其余配置保持明文（可手工备份/迁移）
      let out = sealCookieField(this.data, this.codec && this.codec.encrypt);
      // 上次解密失败 -> 原始信封原样写回，避免凭据被空串永久抹掉
      if (this._preserveEnvelope && (!out.cookie || typeof out.cookie !== 'object')) {
        out = { ...out, cookie: this._preserveEnvelope };
      } else if (out.cookie && typeof out.cookie === 'object') {
        this._preserveEnvelope = null; // 已成功重新密封，撤销保留
      }
      const json = JSON.stringify(out, null, 2);
      fs.writeFileSync(this.tmpFile, json, 'utf8');
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, this.bakFile);
        } catch {
          // 备份失败不影响主流程
        }
      }
      fs.renameSync(this.tmpFile, this.file);
      this.dirty = false;
      return true;
    } catch (e) {
      console.error('[config] 落盘失败', e);
      return false;
    }
  }

  /** 文件大小（设置页展示用） */
  stat() {
    try {
      const s = fs.statSync(this.file);
      return { path: this.file, size: s.size, mtime: s.mtimeMs };
    } catch {
      return { path: this.file, size: 0, mtime: 0 };
    }
  }
}

module.exports = { ConfigStore, DEFAULTS };
