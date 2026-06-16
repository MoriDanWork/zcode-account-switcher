'use strict';
/**
 * 账号指纹提取
 *
 * 思路：
 *   - config.json 里「启用中的 provider」apiKey 是明文 JWT（base64），
 *     payload 含 user_id —— 这是最稳定的账号唯一标识。
 *   - credentials.json 里的 user_info/access_token 是 enc:v1 加密，
 *     已确认可用 ZCode 的机器绑定密钥解密，用于显示邮箱/头像/用户名。
 *
 * 指纹结构：
 *   { userId, shortId, provider, label, email, name, avatar, capturedAt }
 */
const fs = require('fs');
const { CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');
const { decrypt, decryptJson, isEncrypted } = require('./zcodeCrypto');

/**
 * 解析 JWT payload（不验签，仅读 payload）
 * @param {string} jwt
 * @returns {object|null}
 */
function decodeJwt(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    let p = parts[1];
    // base64url -> base64
    p = p.replace(/-/g, '+').replace(/_/g, '/');
    // 补齐 padding
    while (p.length % 4) p += '=';
    const json = Buffer.from(p, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function readCredentialProfile() {
  try {
    const rawCred = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const activeProviderRaw = rawCred['oauth:active_provider'];
    let activeProvider = 'zai';
    try {
      activeProvider = isEncrypted(activeProviderRaw) ? decrypt(activeProviderRaw) : activeProviderRaw || 'zai';
    } catch (_) {}

    const userInfoKey = `oauth:${activeProvider}:user_info`;
    const userInfo = rawCred[userInfoKey] ? decryptJson(rawCred[userInfoKey]) : null;
    const accessToken = rawCred[`oauth:${activeProvider}:access_token`];
    let accessPayload = null;
    try {
      accessPayload = decodeJwt(isEncrypted(accessToken) ? decrypt(accessToken) : accessToken);
    } catch (_) {}

    return {
      activeProvider,
      email: userInfo && userInfo.email,
      name: userInfo && (userInfo.name || userInfo.username || userInfo.displayName),
      avatar: userInfo && userInfo.avatar,
      credentialUserId: userInfo && userInfo.user_id,
      customerId: accessPayload && accessPayload.customer_id,
      accessUserId: accessPayload && (accessPayload.user_id || accessPayload.sub),
      userKey: accessPayload && accessPayload.user_key,
    };
  } catch (_) {
    return null;
  }
}

/**
 * 从当前 config.json + credentials.json 提取账号指纹
 * @returns {{userId:string, shortId:string, provider:string, label:string} | null}
 */
function extractFingerprint() {
  const profile = readCredentialProfile();

  // 1. 从 config.json 找启用中且带 apiKey 的 provider
  try {
    const rawCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const providers = rawCfg.provider || {};
    // 优先 enabled=true 的；其次任意带 apiKey 的
    const candidates = [];
    for (const [id, p] of Object.entries(providers)) {
      const apiKey = p && p.options && p.options.apiKey;
      if (!apiKey || typeof apiKey !== 'string') continue;
      if (apiKey.startsWith('enc:') || apiKey.length < 30) continue; // 加密的或不像 JWT 跳过
      candidates.push({ id, provider: p, apiKey });
    }
    // enabled 优先
    candidates.sort((a, b) => (b.provider.enabled ? 1 : 0) - (a.provider.enabled ? 1 : 0));

    for (const c of candidates) {
      const payload = decodeJwt(c.apiKey);
      if (payload && (payload.user_id || payload.sub)) {
        const uid = payload.user_id || payload.sub;
        const shortId = String(uid).slice(0, 8);
        const email = profile && profile.email;
        // 邮箱去重 key：有邮箱用邮箱 hash，无邮箱回退 user_id shortId
        const emailShortId = email ? ('em-' + simpleHash(email.toLowerCase()).slice(0, 10)) : shortId;
        return {
          userId: uid,
          shortId,
          emailShortId,
          provider: c.id,
          label: (profile && (profile.email || profile.name)) || '账号-' + shortId,
          email: email,
          name: profile && profile.name,
          avatar: profile && profile.avatar,
          customerId: profile && profile.customerId,
          userKey: profile && profile.userKey,
          source: profile && profile.email ? 'config.jwt+credentials.user_info' : 'config.jwt',
        };
      }
    }
  } catch (_) {}

  // 2. 兜底：从 credentials.json 的 enc:v1 字段取不到内容，
  //    用「未激活 provider 数 + active_provider 加密串前缀」生成弱指纹（仅去重用）
  try {
    const rawCred = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const ap = rawCred['oauth:active_provider'] || '';
    const hash = simpleHash(ap);
    const shortId = hash.slice(0, 8);
    const email = profile && profile.email;
    const emailShortId = email ? ('em-' + simpleHash(email.toLowerCase()).slice(0, 10)) : shortId;
    return {
      userId: (profile && (profile.credentialUserId || profile.accessUserId)) || 'enc-' + hash,
      shortId,
      emailShortId,
      provider: (profile && profile.activeProvider) || '(encrypted)',
      label: (profile && (profile.email || profile.name)) || '账号-' + shortId,
      email: profile && profile.email,
      name: profile && profile.name,
      avatar: profile && profile.avatar,
      customerId: profile && profile.customerId,
      userKey: profile && profile.userKey,
      source: profile && profile.email ? 'credentials.user_info' : 'credentials.fallback',
    };
  } catch (_) {}

  return null;
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

module.exports = { decodeJwt, readCredentialProfile, extractFingerprint };
