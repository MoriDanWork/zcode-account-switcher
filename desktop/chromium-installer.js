'use strict';
/**
 * chromium-installer - 首次使用时自动下载 Playwright Chromium
 *
 * 设计：
 *   - isInstalled() 检测是否已下载
 *   - install(onProgress) 用子进程跑 `npx playwright install chromium`，
 *     实时把 stdout/stderr 行推给 onProgress（main.js 再转发给渲染进程显示进度）
 *
 * 不阻塞 Electron 主进程：install 返回 Promise，下载在子进程里跑。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 检测 Playwright Chromium 是否已下载到本机。
 * 通过尝试调用 chromium.executablePath() + 文件存在性判断。
 */
function isInstalled() {
  try {
    const pw = require('playwright');
    const exe = pw.chromium.executablePath();
    return !!exe && fs.existsSync(exe);
  } catch (_) {
    return false;
  }
}

/**
 * 安装 Chromium。实时回调每行输出。
 * @param {(line:string)=>void} onProgress - 进度回调
 * @returns {Promise<void>} 成功 resolve，失败 reject(Error)
 */
function install(onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const cwd = __dirname; // desktop/ 目录（playwright 装在这里）
    onProgress('开始下载 Chromium（约 170MB，请耐心等待）...');

    // 用 npx 调用本地 playwright 的 install
    // 注意：Windows 下 spawn .cmd 必须加 shell:true，否则报 spawn EINVAL
    // 透传代理环境变量（HTTPS_PROXY/HTTP_PROXY），让网络受限用户也能下载
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['playwright', 'install', 'chromium'],
      {
        cwd,
        windowsHide: true,
        shell: true,
        env: {
          ...process.env,
          // 代理由用户在系统环境变量或 .env 设置，这里透传即可
        },
      }
    );

    let stderrBuf = '';

    const handleLine = (buf, push) => {
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) {
          push(line.trim());
          onProgress(line.trim());
        }
      }
    };

    child.stdout.on('data', (b) => handleLine(b, () => {}));
    child.stderr.on('data', (b) => {
      handleLine(b, (line) => { stderrBuf += line + '\n'; });
    });

    child.on('error', (e) => reject(new Error('启动下载进程失败: ' + e.message)));

    child.on('close', (code) => {
      if (code === 0) {
        onProgress('Chromium 下载完成');
        // 复验
        if (!isInstalled()) {
          reject(new Error('下载进程退出码 0，但 Chromium 仍不可用，请检查网络后重试'));
          return;
        }
        resolve();
      } else {
        reject(new Error('Chromium 下载失败（退出码 ' + code + '）' + (stderrBuf ? '\n' + stderrBuf.slice(-500) : '')));
      }
    });
  });
}

module.exports = { isInstalled, install };
