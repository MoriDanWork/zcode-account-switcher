'use strict';
/**
 * 一次性下载 chromium 脚本（供打包前预下载用）
 *
 * 用法： node install-chromium.js
 * 下载到 %LOCALAPPDATA%\ms-playwright\chromium-1228\
 */
const { spawn } = require('child_process');

console.log('[install] 开始下载 chromium（playwright 1.61 需要 v1228，约 184MB）...');

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'install', 'chromium'],
  { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true }
);

let lastProgress = Date.now();
let gotAny = false;

const onData = (buf) => {
  const text = buf.toString('utf8');
  // playwright 进度是 \r 覆盖式，按 \r 和 \n 切分取最后一段
  const segs = text.split(/[\r\n]/);
  for (const s of segs) {
    const t = s.trim();
    if (!t) continue;
    gotAny = true;
    lastProgress = Date.now();
    // 只打印带百分比的进度行，减少噪音
    if (/%|Downloading|installed|Chromium|playwright|MiB|MB/i.test(t)) {
      process.stdout.write(t + '\n');
    }
  }
};

child.stdout.on('data', onData);
child.stderr.on('data', onData);

// 心跳：每 15s 打印一次「还在跑」，确认进程没死
const heartbeat = setInterval(() => {
  const idle = Math.round((Date.now() - lastProgress) / 1000);
  if (gotAny && idle > 30) {
    console.log(`[heartbeat] 仍在下载，已 ${idle}s 无进度输出（大文件传输中属正常）`);
  } else {
    console.log(`[heartbeat] 进程运行中...`);
  }
}, 15000);

child.on('error', (e) => {
  clearInterval(heartbeat);
  console.error('[install] 启动失败: ' + e.message);
  process.exit(1);
});

child.on('close', (code) => {
  clearInterval(heartbeat);
  if (code === 0) {
    // 复验
    try {
      const pw = require('playwright');
      const exe = pw.chromium.executablePath();
      const fs = require('fs');
      if (exe && fs.existsSync(exe)) {
        console.log('[install] ✓ chromium 下载完成: ' + exe);
        process.exit(0);
      } else {
        console.error('[install] ✗ 退出码 0 但 chromium 仍不可用: ' + exe);
        process.exit(2);
      }
    } catch (e) {
      console.error('[install] ✗ 复验失败: ' + e.message);
      process.exit(2);
    }
  } else {
    console.error('[install] ✗ 下载失败，退出码 ' + code);
    process.exit(code || 3);
  }
});
