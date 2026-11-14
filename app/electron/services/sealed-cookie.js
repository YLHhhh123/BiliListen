'use strict';
/**
 * Cookie 字段的「信封」加密落盘
 *
 * 目标：磁盘上的 bili-listen-config.json 不再出现明文 SESSDATA。
 *  - Windows 上用 Electron safeStorage（底层 DPAPI，绑定当前系统用户）加密；
 *  - 信封形态：cookie 字段变成 { __sealed: 1, data: "<base64>" }；
 *  - 主进程内存里仍是明文（unseal 在 load 时执行），所有取用点零改动；
 *  - 旧版明文配置读到后原样透传，下一次落盘自动迁移成信封；
 *  - 加密不可用（isEncryptionAvailable=false）时保持明文兜底，行为同旧版。
 *
 * 纯函数、不 require electron —— 加解密回调由调用方注入，方便单测。
 */

const SEALED_FLAG = '__sealed';

/** 判断一个 cookie 字段值是不是信封形态 */
function isSealedEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && v[SEALED_FLAG] === 1;
}

/**
 * 落盘前：把明文 cookie 换成加密信封（浅拷贝，不改原对象）。
 * @param {object} data  完整配置
 * @param {(text:string)=>Buffer|null} [encrypt]  加密回调；返回 null/抛错 = 明文兜底
 */
function sealCookieField(data, encrypt) {
  const cookie = data && data.cookie;
  if (typeof cookie !== 'string' || !cookie.trim()) return data;
  let sealed = null;
  try {
    sealed = encrypt ? encrypt(cookie) : null;
  } catch {
    sealed = null;
  }
  if (!sealed || !sealed.length) return data; // 加密不可用 → 保持旧版明文行为
  const out = { ...data };
  out.cookie = { [SEALED_FLAG]: 1, data: Buffer.from(sealed).toString('base64') };
  return out;
}

/**
 * 读盘后：把信封解回明文（浅拷贝，不改原对象）。
 * 明文旧数据原样透传（触发自动迁移）；解密失败按「未登录」处理，不让坏数据崩应用。
 * @param {object} obj  磁盘上的配置
 * @param {(buf:Buffer)=>string} [decrypt]  解密回调
 */
function unsealCookieField(obj, decrypt) {
  if (!isSealedEnvelope(obj && obj.cookie)) return obj;
  const out = { ...obj };
  try {
    const plain = decrypt ? decrypt(Buffer.from(String(obj.cookie.data || ''), 'base64')) : '';
    out.cookie = typeof plain === 'string' ? plain : '';
    if (!out.cookie) {
      console.error('[sealed] 解密返回空值，信封 data 长度 =', String((obj.cookie && obj.cookie.data) || '').length);
      // 同样按解密失败处理：保留原始信封，别把唯一一份密文覆盖成空串
      out.cookie = '';
      out.user = null;
      out.__sealedCookieRaw = obj.cookie;
    }
  } catch (e) {
    console.error(
      '[sealed] 解密失败，按未登录处理：dataLen =',
      String((obj.cookie && obj.cookie.data) || '').length,
      'err =',
      e && (e.stack || e.message || String(e)),
    );
    out.cookie = '';
    out.user = null;
    // 关键：把原始信封挂到临时字段，让 ConfigStore 在后续任何落盘时原样写回。
    // 否则一次偶然解密失败（密钥尚未落盘 / 系统用户变更）就会把磁盘上
    // 唯一的密文覆盖成空串，登录凭据永久丢失，连重试的机会都没有。
    out.__sealedCookieRaw = obj.cookie;
  }
  return out;
}

module.exports = { sealCookieField, unsealCookieField, isSealedEnvelope, SEALED_FLAG };
