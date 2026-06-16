#!/usr/bin/env node
'use strict';
/**
 * ZCode 账号无感切换 CLI
 *
 * （Windows 控制台默认 GBK，Node 输出 UTF-8 会乱码。
 *  这里在进程启动时把 stdout/stderr 切到 UTF-8，保证中文正常。） */
try {
  if (process.stdout.isTTY && typeof process.stdout.handle?.setEncoding === 'function') {
    process.stdout.handle.setEncoding('utf8');
  }
} catch (_) {}
// 强制以 UTF-8 解码写入
try { process.stdout.setDefaultEncoding('utf8'); } catch (_) {}
try { process.stderr.setDefaultEncoding('utf8'); } catch (_) {}

/**
 * ZCode 账号无感切换 CLI
 *
 * 用法：
 *   node src/cli.js status                          查看当前登录账号 + 已保存账号列表
 *   node src/cli.js capture [--name 备注] [--note 说明]   把当前 ZCode 登录态存为账号快照
 *   node src/cli.js list                            列出所有已保存账号
 *   node src/cli.js use <id|序号> [--no-restart] [--force]   切换到指定账号（默认自动重启 ZCode）
 *   node src/cli.js delete <id|序号>                删除账号快照
 *   node src/cli.js rename <id|序号> <新名称>       重命名账号
 *   node src/cli.js rollback                        回滚到切换前的登录态
 *
 * 备注：<id|序号> 既可用账号短 ID（如 a86931xx），也可用 list 里的序号（1,2,3...）
 */
const manager = require('./manager');
const switcher = require('./switcher');
const quota = require('./quota');
const { findZCodeExe, CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');

function parseArgs(argv) {
  const out = { _: [], flags: {}, kv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.kv[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 序号或 id 都能解析 */
function resolveId(input) {
  if (!input) throw new Error('请提供账号 id 或序号');
  const list = manager.list();
  if (list.length === 0) throw new Error('没有已保存的账号');
  // 纯数字 → 序号
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10);
    if (idx < 1 || idx > list.length) throw new Error(`序号超出范围（1~${list.length}）`);
    return list[idx - 1].id;
  }
  // 否则当 id（支持前缀匹配）
  const exact = list.find((x) => x.id === input);
  if (exact) return exact.id;
  const pref = list.filter((x) => x.id.startsWith(input));
  if (pref.length === 1) return pref[0].id;
  if (pref.length > 1) throw new Error('id 前缀匹配到多个账号，请输入更完整的 id');
  throw new Error('找不到账号: ' + input);
}

function printTable(list) {
  if (list.length === 0) {
    console.log('  （暂无已保存的账号，使用 `capture` 添加）');
    return;
  }
  console.log('');
  console.log('  序号  id          名称                 provider                 捕获时间            大小');
  console.log('  ----  ----------  -------------------  -----------------------  ------------------  ----');
  list.forEach((a, i) => {
    const no = String(i + 1).padStart(4);
    const id = (a.id || '').padEnd(10).slice(0, 10);
    const label = (a.label || '').padEnd(19).slice(0, 19);
    const prov = (a.provider || '').padEnd(23).slice(0, 23);
    const dt = fmtDate(a.capturedAt).padEnd(18);
    const sz = (a.sizeKb || 0) + 'KB';
    console.log(`  ${no}  ${id}  ${label}  ${prov}  ${dt}  ${sz}`);
  });
  console.log('');
}

function fmtQuota(value) {
  if (value == null) return '未知';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function printQuota(q) {
  console.log('=== ZCode 额度 ===');
  console.log('总量:   ' + fmtQuota(q.total));
  console.log('已用:   ' + fmtQuota(q.used));
  console.log('剩余:   ' + fmtQuota(q.remaining));
  console.log('进度:   ' + (q.percentUsed == null ? '未知' : q.percentUsed.toFixed(1) + '%'));
  if (q.refreshedAt) console.log('刷新:   ' + fmtDate(q.refreshedAt));
  if (q.items && q.items.length) {
    console.log('');
    console.log('▶ 分项额度:');
    q.items.forEach((item) => {
      console.log(`  - ${item.name}: 剩余 ${fmtQuota(item.remaining)} / 总量 ${fmtQuota(item.total)} (${item.unit || 'quota'})`);
    });
  }
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const args = parseArgs(process.argv.slice(3));

async function main() {
  switch (cmd) {
    case 'status': {
      const cur = manager.current();
      console.log('=== ZCode 账号切换器 ===');
      console.log('ZCode 客户端: ' + (findZCodeExe() || '未找到'));
      console.log('运行状态:     ' + (switcher.isZCodeRunning() ? '✅ 运行中' : '⛔ 未运行'));
      console.log('登录态目录:   ' + require('path').dirname(CREDENTIALS_FILE));
      if (cur) {
        console.log('');
        console.log('▶ 当前登录账号:');
        console.log('  指纹 ID:  ' + cur.shortId + (cur.userId ? '  (user_id=' + cur.userId + ')' : ''));
        console.log('  来源:     ' + cur.source);
        console.log('  Provider: ' + cur.provider);
      } else {
        console.log('\n⚠ 无法识别当前登录账号（可能未登录，或登录态已加密无法读取）');
      }
      console.log('');
      console.log('▶ 已保存账号快照:');
      printTable(manager.list());
      return;
    }

    case 'list': {
      printTable(manager.list());
      return;
    }

    case 'quota': {
      const q = await quota.getQuotaOverview();
      printQuota(q);
      return;
    }

    case 'capture': {
      const r = manager.capture({
        label: args.kv.name,
        note: args.kv.note || '',
        overwrite: !!args.flags.overwrite,
      });
      if (r.created) {
        console.log('✅ 已捕获账号: ' + r.meta.label + '  (id=' + r.meta.id + ')');
      } else if (r.skipped) {
        console.log('ℹ ' + r.message + '。如要覆盖，加 --overwrite。');
      }
      return;
    }

    case 'use': {
      const id = resolveId(args._[0]);
      const meta = JSON.parse(require('fs').readFileSync(manager.metaPath(id), 'utf8'));
      console.log('🔄 切换到账号: ' + meta.label + '  (id=' + id + ')');
      const opts = {
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false, // 默认 force
      };
      const r = await manager.use(id, opts);
      console.log('✅ 登录态已切换。');
      if (r.restarted) console.log('🚀 ZCode 已自动重启，登录态即刻生效。');
      else console.log('ℹ ZCode 未自动重启（使用 --no-restart 关闭了，或启动失败）。手动启动即可。');
      return;
    }

    case 'delete':
    case 'remove': {
      const id = resolveId(args._[0]);
      const ok = manager.remove(id);
      console.log(ok ? '🗑 已删除账号: ' + id : '⚠ 未找到账号: ' + id);
      return;
    }

    case 'rename': {
      const id = resolveId(args._[0]);
      const newName = args._[1];
      if (!newName) throw new Error('请提供新名称');
      const m = manager.rename(id, newName);
      console.log('✏ 已重命名: ' + m.label);
      return;
    }

    case 'rollback': {
      const r = await switcher.rollback({
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false,
      });
      console.log('↩ 已回滚到切换前的登录态。');
      if (r.restarted) console.log('🚀 ZCode 已重启。');
      return;
    }

    case 'kill': {
      const running = switcher.isZCodeRunning();
      if (!running) { console.log('ZCode 未在运行。'); return; }
      console.log('关闭 ZCode...');
      const ok = await switcher.killZCode();
      console.log(ok ? '✅ 已关闭。' : '⚠ 关闭超时。');
      return;
    }

    case 'launch': {
      try { switcher.launchZCode(); console.log('🚀 已启动 ZCode。'); }
      catch (e) { console.error('❌ ' + e.message); process.exit(1); }
      return;
    }

    default:
      console.log('ZCode 账号无感切换工具\n');
      console.log('用法:');
      console.log('  status                          查看当前账号 + 已保存列表');
      console.log('  capture [--name 备注]           把当前登录态存为快照');
      console.log('  list                            列出所有账号');
      console.log('  quota                           查询当前账号额度');
      console.log('  use <id|序号> [--no-restart]    切换账号（默认自动重启 ZCode）');
      console.log('  delete <id|序号>                删除账号');
      console.log('  rename <id|序号> <新名称>       重命名');
      console.log('  rollback                        回滚到切换前');
      console.log('  kill / launch                   手动关闭 / 启动 ZCode');
  }
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
