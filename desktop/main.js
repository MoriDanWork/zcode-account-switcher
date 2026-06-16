'use strict';
/**
 * Electron 主进程
 *
 * 职责：
 *   1. 创建应用窗口
 *   2. 通过 IPC 桥接渲染进程 ↔ 已验证的后端模块（manager / switcher）
 *
 * 安全：contextIsolation=true + preload 受限 API，渲染进程不直接接触 Node。
 *
 * 注意：若启动无窗口，请检查环境变量 ELECTRON_RUN_AS_NODE 是否被设为 1
 *      （会让 electron 退化成纯 node）。启动脚本已自动清除它。
 */
const fs = require('fs');
const path = require('path');

// ===== 全局错误捕获 → 写日志（便于排查启动崩溃）=====
const LOG_FILE = path.join(__dirname, 'main.log');
function logErr(stage, e) {
  const line = `[${new Date().toISOString()}] ${stage}: ${e && e.stack ? e.stack : e}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
}
process.on('uncaughtException', (e) => logErr('uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('unhandledRejection', e));

const { app, BrowserWindow, ipcMain, shell } = require('electron');

// 复用上一层目录 src/ 里已验证的后端逻辑
const manager = require('../src/manager');
const switcher = require('../src/switcher');
const oauth = require('../src/oauth');
const quota = require('../src/quota');
const { oauthBrowser } = require('../src/oauthBrowser');
const chromiumInstaller = require('./chromium-installer');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // 开发模式由 vite 提供
let mainWindow = null;

// 通用日志（信息级，写 main.log）
function logInfo(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1080,
    minHeight: 680,
    title: 'ZCode 账号切换器',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require 路径相关能力，关闭 sandbox
    },
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
  }

  // 捕获渲染进程的 console 与错误，便于排查白屏/JS 报错
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    logInfo(`[renderer:${tag}] ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logErr('render-process-gone', new Error(JSON.stringify(details)));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logInfo(`[did-fail-load] ${code} ${desc}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logInfo('[did-finish-load] renderer loaded');
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ===== IPC 处理器（全部 try/catch，返回 {ok, data?, error?} 统一结构）=====

const wrap = async (fn, channel) => {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    logInfo(`[ipc:${channel || 'call'}] error: ${e && e.message ? e.message : e}`);
    return { ok: false, error: e.message || String(e) };
  }
};

// 把 OAuth 安装/操作进度推给渲染进程（用于 AddAccountModal 实时显示）
function sendProgress(msg) {
  logInfo('[oauth-progress] ' + msg);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth:install-progress', msg);
    }
  } catch (_) {}
}

// 把全自动添加账号的流程事件推给渲染进程
function sendFlowEvent(event) {
  logInfo('[oauth-flow] ' + event.type + (event.message ? ': ' + event.message : ''));
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth:flow-event', event);
    }
  } catch (_) {}
}

ipcMain.handle('account:status', async () =>
  wrap(() => {
    const cur = manager.current();
    const running = switcher.isZCodeRunning();
    const hasLast = switcher.hasLastBackup();
    return { current: cur, zcodeRunning: running, hasLastBackup: hasLast };
  }, 'status')
);

ipcMain.handle('account:list', async () => wrap(() => manager.list(), 'list'));

ipcMain.handle('account:capture', async (_evt, opts) =>
  wrap(() => manager.capture(opts || {}), 'capture')
);

ipcMain.handle('account:use', async (_evt, id) =>
  wrap(() => manager.use(id, { restart: true, force: true }), 'use')
);

ipcMain.handle('account:delete', async (_evt, id) =>
  wrap(() => ({ removed: manager.remove(id) }), 'delete')
);

ipcMain.handle('account:rename', async (_evt, id, label) =>
  wrap(() => manager.rename(id, label), 'rename')
);

// ===== OAuth 添加账号（方案 A：内嵌浏览器自动换 token）=====
// 状态机：need-install(首次) → installing(下载中) → browser-open(等用户登录) → logged-in(可添加)

// 检查 chromium 是否就绪（不启动浏览器）
ipcMain.handle('account:oauth-check-browser', async () =>
  wrap(() => ({ installed: chromiumInstaller.isInstalled() }), 'oauth-check-browser')
);

// 安装 chromium（首次）。进度通过 oauth:install-progress 事件推给渲染进程。
ipcMain.handle('account:oauth-install', async () => {
  try {
    if (chromiumInstaller.isInstalled()) return { ok: true, data: { installed: true } };
    sendProgress('正在下载 Chromium，请稍候...');
    await chromiumInstaller.install((line) => sendProgress(line));
    return { ok: true, data: { installed: true } };
  } catch (e) {
    logInfo('[oauth-install] error: ' + (e && e.message));
    return { ok: false, error: e.message || String(e) };
  }
});

// ===== 全自动添加账号（方案 A：无痕浏览器 + 自动换 token）=====
// 前端调一次 oauth-auto-start，全程通过 oauth:flow-event 事件接收阶段进度，
// 登录成功后自动换 token + 写盘 + 快照，前端收到 done 即关闭刷新。

ipcMain.handle('account:oauth-auto-start', async (_evt, opts) => {
  try {
    if (!chromiumInstaller.isInstalled()) {
      return { ok: false, error: 'Chromium 未安装，请先点击安装', needInstall: true };
    }
    const { label, note } = opts || {};

    // 启动全自动流程：开浏览器 → 轮询登录 → 自动换 token
    // 通过 onEvent 回调把每个阶段推给前端
    oauthBrowser
      .startAddAccountFlow(async (event) => {
        // 实时推阶段给前端
        sendFlowEvent(event);

        // done：自动写盘 + 快照
        if (event.type === 'done' && event.tokenSet) {
          try {
            const result = oauth.finishLogin({
              tokenSet: event.tokenSet,
              label,
              note: note || '',
              overwrite: true,
            });
            sendFlowEvent({ type: 'saved', account: result.account, email: event.email, skipped: result.skipped });
          } catch (e) {
            sendFlowEvent({ type: 'error', message: '保存账号失败：' + (e.message || e) });
          }
        }
      })
      .catch((e) => {
        logInfo('[oauth-auto-start] flow error: ' + (e && e.message));
        sendFlowEvent({ type: 'error', message: '启动流程失败：' + (e.message || e) });
      });

    return { ok: true };
  } catch (e) {
    logInfo('[oauth-auto-start] error: ' + (e && e.message));
    return { ok: false, error: e.message || String(e) };
  }
});

// 取消全自动流程（关闭浏览器 + 停轮询）
ipcMain.handle('account:oauth-cancel', async () =>
  wrap(async () => {
    await oauthBrowser.close();
    return { stopped: true };
  }, 'oauth-cancel')
);

ipcMain.handle('shell:open-external', async (_evt, url) =>
  wrap(() => shell.openExternal(url), 'open-external')
);

ipcMain.handle('account:quota', async () =>
  wrap(() => quota.getQuotaOverview(), 'quota')
);

ipcMain.handle('account:quota-one', async (_evt, id) =>
  wrap(() => quota.getAccountQuota(id), 'quota-one')
);

ipcMain.handle('account:quota-many', async (_evt, ids) =>
  wrap(async () => {
    const list = Array.isArray(ids) ? ids : [];
    const out = {};
    for (const id of list) {
      try {
        out[id] = { ok: true, data: await quota.getAccountQuota(id) };
      } catch (e) {
        out[id] = { ok: false, error: e.message || String(e) };
      }
    }
    return out;
  }, 'quota-many')
);

ipcMain.handle('account:rollback', async () =>
  wrap(() => switcher.rollback({ restart: true, force: true }), 'rollback')
);

// ===== 生命周期 =====
app.whenReady().then(() => {
  logInfo(`main start (electron ${process.versions.electron}, chrome ${process.versions.chrome})`);
  logInfo('backend modules loaded: manager, switcher');
  createWindow();
});

app.on('window-all-closed', () => {
  // 退出前关闭 OAuth 浏览器，避免遗留 chromium 进程
  oauthBrowser.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  oauthBrowser.close().catch(() => {});
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
