'use strict';
/**
 * OAuthBrowser - Playwright 自动化换 token（无痕 + 全自动）
 *
 *   1. 启动 Chromium（无痕模式：每次 newContext，不持久化，互不污染）
 *   2. startAddAccountFlow：打开登录页 → 后台轮询登录态
 *      → 用户输账号密码登录成功的瞬间，自动 exchangeToken 拿 token
 *   3. 全程用户只需在浏览器里登录，无需回工具点按钮
 *
 * 不含验证码逻辑：账户切换器只需拿 token，不调 messages API。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===== Z.ai OAuth 常量（与 src/oauth.js、zcode2api config.js 一致）=====
const OAUTH = {
  authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  appId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
  redirectUri: 'zcode://zai-auth/callback',
  provider: 'zai',
};

// playwright 装在 desktop/node_modules（本模块在 src/ 下被 desktop/main.js 调用）。
function loadPlaywright() {
  const candidates = [
    path.join(__dirname, '..', 'desktop', 'node_modules', 'playwright', 'index.js'),
    path.join(__dirname, '..', 'node_modules', 'playwright', 'index.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (_) {}
  }
  return require('playwright');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 反自动化检测的最小指纹脚本
const FINGERPRINT_SCRIPT = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] }); } catch (e) {}
  try { Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }); } catch (e) {}
  if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
})();
`;

class OAuthBrowser {
  constructor() {
    this._pw = null;
    this._browser = null;  // chromium.launch() 返回的浏览器实例
    this._context = null;  // 无痕 context（newContext）
    this._page = null;
    this._starting = null;
    this._flowTimer = null;  // 全自动流程的轮询定时器
    this._flowDone = false;  // 流程是否已结束（防止重复触发）
  }

  /**
   * 启动 Chromium + 新建无痕 context。
   * @param {object} opts
   * @param {function} opts.onProgress - 进度回调 (msg:string) => void
   * @param {string} opts.executablePath - 可选，已知的 chromium 路径
   */
  async ensureBrowser({ onProgress = () => {}, executablePath } = {}) {
    if (this._context) return this._context;
    if (this._starting) return this._starting;

    this._starting = (async () => {
      onProgress('加载浏览器引擎...');
      this._pw = loadPlaywright();

      let exe = executablePath;
      if (!exe) {
        onProgress('查找 Chromium...');
        exe = await resolveChromiumPath(this._pw);
      }
      if (!exe) throw new Error('Chromium 未安装，请先调用安装');
      onProgress('启动浏览器（无痕模式）...');

      // 无痕：launch 一个浏览器实例，每次 newContext（不写磁盘，关掉即清空）
      this._browser = await this._pw.chromium.launch({
        headless: false,
        executablePath: exe,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          '--incognito',
        ],
      });

      this._context = await this._browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1100, height: 760 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      });

      await this._context.addInitScript(FINGERPRINT_SCRIPT);
      this._page = await this._context.newPage();

      // 用户手动关闭浏览器窗口时，清理内部状态
      this._context.on('close', () => this._resetState());
      this._browser.on('disconnected', () => this._resetState());

      onProgress('就绪');
      return this._context;
    })();
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  _resetState() {
    this._browser = null;
    this._context = null;
    this._page = null;
    this._starting = null;
    this.stopFlow();
  }

  /**
   * 返回当前登录态（不阻塞）。
   * @returns {Promise<{loggedIn:boolean, email?:string, isGuest?:boolean, browserOpen:boolean}>}
   */
  async getLoginStatus() {
    if (!this._context) return { loggedIn: false, browserOpen: false };

    const url = this._page.url();
    if (!url.startsWith('https://chat.z.ai')) {
      await this._page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(1200);
    }

    const status = await this._page
      .evaluate(async () => {
        const tok = localStorage.getItem('token');
        if (!tok) return { loggedIn: false };
        try {
          const r = await fetch('/api/v1/auths/', { headers: { Authorization: 'Bearer ' + tok } });
          if (!r.ok) return { loggedIn: false };
          const j = await r.json();
          return { loggedIn: true, email: j.email, isGuest: (j.email || '').startsWith('guest-') };
        } catch {
          return { loggedIn: false };
        }
      })
      .catch(() => ({ loggedIn: false }));

    return { ...status, browserOpen: true };
  }

  /**
   * ⭐ 全自动添加账号流程：
   *   开浏览器到登录页 → 后台每 1.5s 轮询登录态
   *   → 检测到「已登录且非游客」→ 自动 exchangeToken → 通过 onEvent 回调返回 tokenSet
   *
   * 调用方（main.js）拿到 tokenSet 后调 oauth.finishLogin 写盘 + 快照。
   *
   * @param {function} onEvent - (event:{type:string, ...}) => void
   *   event.type: 'browser-open' | 'waiting-login' | 'detected' | 'exchanging' | 'done' | 'error'
   * @returns {Promise<void>}
   */
  async startAddAccountFlow(onEvent = () => {}) {
    this._flowDone = false;
    this.stopFlow(); // 清掉上一次的定时器

    await this.ensureBrowser({ onProgress: (m) => onEvent({ type: 'browser-open', message: m }) });

    // 打开 chat.z.ai/auth（直接登录页，可直接输账号密码，无需先点登录）
    await this._page.goto('https://chat.z.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    onEvent({ type: 'browser-open', message: '已打开登录页，请输入账号密码' });

    // 轮询检测登录态
    this._flowTimer = setInterval(async () => {
      if (this._flowDone) return;
      try {
        const status = await this.getLoginStatus();
        if (status.loggedIn && !status.isGuest) {
          this._flowDone = true;
          this.stopFlow();
          onEvent({ type: 'detected', email: status.email });
          // 自动换 token（分步进度回调，缓解等待焦虑）
          try {
            onEvent({ type: 'exchanging', message: '正在处理，请稍候…' });
            const tokenSet = await this.exchangeToken((stepMsg) => {
              onEvent({ type: 'exchanging', message: stepMsg });
            });
            onEvent({ type: 'exchanging', message: '③ 正在保存账号…' });
            onEvent({ type: 'done', tokenSet, email: status.email });
          } catch (e) {
            onEvent({ type: 'error', message: '换 token 失败：' + (e.message || e) });
          }
        } else if (status.loggedIn && status.isGuest) {
          // 游客不算，继续等
          onEvent({ type: 'waiting-login', message: '检测到游客登录，请用注册账号登录' });
        }
      } catch (e) {
        // 轮询出错不打断流程，下次重试
      }
    }, 1500);

    onEvent({ type: 'waiting-login', message: '请在浏览器窗口登录 Z.ai 账号' });
  }

  /** 停止全自动流程的轮询 */
  stopFlow() {
    if (this._flowTimer) {
      clearInterval(this._flowTimer);
      this._flowTimer = null;
    }
  }

  /**
   * 在已登录会话里自动换 token（复刻 zcode2api refreshToken 核心）。
   * @param {(msg:string)=>void} [onStep] 分步进度回调（缓解等待焦虑）
   * @returns {Promise<{token:string, zaiAccessToken?:string, refreshToken?:string, user:object}>}
   */
  async exchangeToken(onStep = () => {}) {
    if (!this._context) throw new Error('浏览器未启动');

    // 步骤 1：触发授权页（带 state）
    const state = crypto.randomBytes(32).toString('hex');
    const authUrl =
      OAUTH.authorizeUrl +
      '?' +
      new URLSearchParams({
        client_id: OAUTH.appId,
        redirect_uri: OAUTH.redirectUri,
        response_type: 'code',
        state,
      }).toString();

    await this._page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // 注：原 sleep(1500) 已移除 —— DOM 就绪后同源 cookie 已可用，
    // 下一步 fetch('/api/oauth/authorize') 可立即执行，省去 1.5s 硬等

    // 步骤 2：页面内 POST /api/oauth/authorize（带 session cookie），拿 redirect_url 里的 code
    onStep('① 正在获取授权码…');
    let code = null;
    const result = await this._page
      .evaluate(
        async (cfg) => {
          const res = await fetch('/api/oauth/authorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: cfg.appId,
              redirect_uri: cfg.redirectUri,
              state: cfg.state,
              response_type: 'code',
              action: 'approve',
            }).toString(),
          });
          return { status: res.status, body: await res.text() };
        },
        { appId: OAUTH.appId, redirectUri: OAUTH.redirectUri, state }
      )
      .catch(() => null);

    if (result) {
      try {
        const d = JSON.parse(result.body);
        if (d.redirect_url) code = new URL(d.redirect_url).searchParams.get('code');
        else if (d.error) throw new Error('授权失败: ' + (d.message || d.error));
      } catch (e) {
        if (e.message.startsWith('授权')) throw e;
      }
    }
    if (!code) throw new Error('未拿到 OAuth code（可能未登录或会话已过期，请在浏览器窗口重新登录）');

    // 步骤 3：换 token（立即调用，code 新鲜不过期）
    onStep('② 正在换取令牌…');
    const tokenRes = await fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: OAUTH.provider,
        code,
        redirect_uri: OAUTH.redirectUri,
        state,
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => '');
      throw new Error('换 token HTTP ' + tokenRes.status + ': ' + t.slice(0, 200));
    }
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) {
      throw new Error('换 token 失败 (code=' + tokenData.code + '): ' + JSON.stringify(tokenData).slice(0, 200));
    }

    const payload = tokenData.data || {};
    const token = payload.token;
    if (!token) throw new Error('换 token 成功但响应缺少 data.token（zcode JWT）');

    return {
      token,
      zaiAccessToken: payload.zai?.access_token,
      refreshToken: payload.zai?.refresh_token,
      user: payload.user || {},
    };
  }

  /** 关闭浏览器（同时停轮询） */
  async close() {
    this.stopFlow();
    if (this._context) {
      await this._context.close().catch(() => {});
    }
    if (this._browser) {
      await this._browser.close().catch(() => {});
    }
    this._resetState();
  }

  /** 浏览器是否已打开 */
  isOpen() {
    return !!this._context;
  }
}

/**
 * 解析 playwright chromium 可执行文件路径。
 */
async function resolveChromiumPath(pw) {
  try {
    const exe = pw.chromium.executablePath();
    if (exe && fs.existsSync(exe)) return exe;
  } catch (_) {}
  return null;
}

const oauthBrowser = new OAuthBrowser();
module.exports = { OAuthBrowser, oauthBrowser, OAUTH, resolveChromiumPath };
