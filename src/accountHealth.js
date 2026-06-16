'use strict';
/**
 * 账号快照健康检查
 *
 * 目标：在真正切换前，尽量用轻量级静态检查判断一份账号快照是否“完整 / 可读 / 大概率可用”。
 * 这里只做本地结构与字段检查，不主动访问网络。
 */
const { decodeJwt } = require('./fingerprint');
const { decrypt, decryptJson, isEncrypted } = require('./zcodeCrypto');
const quota = require('./quota');

function validateSnapshot(snapshot, meta = {}) {
  const details = {
    hasCredentials: false,
    hasConfig: false,
    canParseCredentials: false,
    canParseConfig: false,
    hasTokens: false,
    canDecryptUserInfo: false,
    hasProviderApiKey: false,
    userId: meta.userId || null,
    provider: meta.provider || null,
  };
  const warnings = [];
  const errors = [];

  if (!snapshot || typeof snapshot !== 'object') {
    return finalize(details, warnings, ['账号快照不存在或格式不正确']);
  }

  details.hasCredentials = typeof snapshot.credentials === 'string' && snapshot.credentials.trim() !== '';
  details.hasConfig = typeof snapshot.config === 'string' && snapshot.config.trim() !== '';

  if (!details.hasCredentials) errors.push('缺少 credentials 登录态');
  if (!details.hasConfig) errors.push('缺少 config 登录态');
  if (!details.hasCredentials || !details.hasConfig) return finalize(details, warnings, errors);

  let credentials = null;
  let config = null;

  try {
    credentials = JSON.parse(snapshot.credentials);
    details.canParseCredentials = true;
  } catch (_) {
    errors.push('credentials.json 不是有效 JSON');
  }

  try {
    config = JSON.parse(snapshot.config);
    details.canParseConfig = true;
  } catch (_) {
    errors.push('config.json 不是有效 JSON');
  }

  if (!details.canParseCredentials || !details.canParseConfig) return finalize(details, warnings, errors);

  const tokens = quota.readCandidateTokensFromSnapshot(snapshot);
  details.hasTokens = tokens.length > 0;
  if (!details.hasTokens) {
    errors.push('未找到可用于登录/查询的 token');
  }

  const providerInfo = extractProviderInfo(credentials, config);
  details.provider = details.provider || providerInfo.provider || null;
  details.hasProviderApiKey = !!providerInfo.apiKey;
  details.userId = details.userId || providerInfo.userId || null;

  if (!details.hasProviderApiKey) {
    warnings.push('未找到启用中的 provider apiKey');
  }
  if (!details.userId) {
    warnings.push('无法从快照解析出稳定 user_id');
  }

  const userInfoState = checkUserInfo(credentials, providerInfo.provider);
  details.canDecryptUserInfo = userInfoState.canDecryptUserInfo;
  if (userInfoState.warning) warnings.push(userInfoState.warning);

  return finalize(details, warnings, errors);
}

function extractProviderInfo(credentials, config) {
  const activeProvider = readActiveProvider(credentials);
  const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const candidates = [];

  for (const [id, p] of Object.entries(providers)) {
    const apiKey = p && p.options && p.options.apiKey;
    if (!apiKey || typeof apiKey !== 'string') continue;
    const payload = decodeJwt(apiKey);
    candidates.push({
      id,
      enabled: !!(p && p.enabled),
      apiKey,
      userId: payload && (payload.user_id || payload.sub),
    });
  }

  candidates.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const preferred = candidates[0] || null;

  return {
    provider: activeProvider || (preferred && preferred.id) || null,
    apiKey: preferred && preferred.apiKey,
    userId: preferred && preferred.userId,
  };
}

function readActiveProvider(credentials) {
  if (!credentials || typeof credentials !== 'object') return null;
  const value = credentials['oauth:active_provider'];
  if (!value) return null;
  try {
    if (isEncrypted(value)) {
      const plain = decrypt(value);
      return typeof plain === 'string' ? plain : null;
    }
  } catch (_) {}
  return typeof value === 'string' ? value : null;
}

function checkUserInfo(credentials, provider) {
  if (!credentials || typeof credentials !== 'object') {
    return { canDecryptUserInfo: false, warning: 'credentials 结构异常，无法检查 user_info' };
  }

  const keys = [];
  if (provider) keys.push(`oauth:${provider}:user_info`);
  keys.push('oauth:zai:user_info', 'oauth:bigmodel:user_info');

  for (const key of keys) {
    const value = credentials[key];
    if (!value) continue;
    if (!isEncrypted(value)) return { canDecryptUserInfo: true };
    try {
      const data = decryptJson(value);
      if (data && typeof data === 'object') return { canDecryptUserInfo: true };
      return { canDecryptUserInfo: false, warning: 'user_info 存在，但解密后不是有效 JSON' };
    } catch (_) {
      return { canDecryptUserInfo: false, warning: 'user_info 无法在当前机器环境解密' };
    }
  }

  return { canDecryptUserInfo: false, warning: '未找到 user_info，界面信息可能不完整' };
}

function finalize(details, warnings, errors) {
  const status = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'healthy';
  const summary =
    status === 'healthy'
      ? '快照完整，可正常使用'
      : status === 'warning'
        ? warnings[0]
        : errors[0];
  return { status, summary, warnings, errors, details };
}

module.exports = {
  validateSnapshot,
};
