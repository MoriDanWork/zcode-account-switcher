import React, { useEffect, useRef, useState } from 'react';
import { Loader2, UserPlus, Download, CheckCircle2, LogIn, ShieldCheck } from 'lucide-react';

/**
 * 添加账号弹窗（全自动：无痕浏览器 + 自动换 token）
 *
 * 用户只需点「开始」，工具会：
 *   1. （首次）自动下载 chromium
 *   2. 自动打开无痕浏览器到登录页
 *   3. 用户在浏览器输账号密码登录
 *   4. 登录成功的瞬间，工具自动换 token + 写盘 + 快照
 *   5. 弹窗显示「✓ 已添加」并自动关闭
 *
 * 全程通过 onFlowEvent 事件接收主进程的阶段回调。
 */
export default function AddAccountModal({ onClose, onDone, showToast }) {
  // phase: checking | installing | opening | waiting | detected | exchanging | saved | error
  const [phase, setPhase] = useState('checking');
  const [progressMsg, setProgressMsg] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  // 局部 busy：只禁用弹窗内按钮，不影响工具栏（全局 busy 会卡死所有操作）
  const [busy, setBusy] = useState(true);
  const unsubFlowRef = useRef(null);
  const unsubProgressRef = useRef(null);

  const cleanup = () => {
    if (unsubFlowRef.current) { unsubFlowRef.current(); unsubFlowRef.current = null; }
    if (unsubProgressRef.current) { unsubProgressRef.current(); unsubProgressRef.current = null; }
  };
  // 卸载兜底：取消事件订阅 + 通知主进程关浏览器（防后台残留）
  useEffect(() => {
    return () => {
      cleanup();
      try { window.api.oauthCancel(); } catch (_) {}
    };
  }, []);

  // 入口：检测 chromium → 启动全自动流程
  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setError('');
    setBusy(true);
    setPhase('checking');
    setProgressMsg('检查浏览器环境...');

    // 1. 检测 chromium
    const check = await window.api.oauthCheckBrowser();
    if (!check.ok) { fail(check.error); return; }

    // 2. 未装则下载
    if (!check.data.installed) {
      setPhase('installing');
      setProgressMsg('开始下载...');
      unsubProgressRef.current = window.api.onOauthProgress((msg) => setProgressMsg(msg));
      const inst = await window.api.oauthInstall();
      if (unsubProgressRef.current) { unsubProgressRef.current(); unsubProgressRef.current = null; }
      if (!inst.ok) { fail(inst.error || 'Chromium 下载失败'); return; }
    }

    // 3. 启动全自动流程（先订阅事件，避免漏早期事件）
    setPhase('opening');
    setProgressMsg('正在打开浏览器...');
    unsubFlowRef.current = window.api.onFlowEvent((event) => handleFlowEvent(event));

    const r = await window.api.oauthAutoStart({});
    if (!r.ok) {
      if (unsubFlowRef.current) { unsubFlowRef.current(); unsubFlowRef.current = null; }
      fail(r.needInstall ? 'Chromium 未就绪，请重试' : r.error);
      return;
    }
    // oauthAutoStart 返回后，流程在后台跑，后续靠 onFlowEvent 推进
  };

  // 处理流程事件
  const handleFlowEvent = (event) => {
    switch (event.type) {
      case 'browser-open':
        setPhase('opening');
        setProgressMsg(event.message || '浏览器已打开');
        break;
      case 'waiting-login':
        setPhase('waiting');
        setProgressMsg(event.message || '等待登录');
        break;
      case 'detected':
        setPhase('detected');
        setEmail(event.email || '');
        break;
      case 'exchanging':
        setPhase('exchanging');
        setProgressMsg(event.message || '正在换取 token...');
        break;
      case 'done':
        // 换 token 成功，等 saved（写盘完成）
        setPhase('exchanging');
        setProgressMsg('token 已获取，正在保存账号...');
        break;
      case 'saved':
        setPhase('saved');
        setBusy(false);
        cleanup();
        if (event.skipped) {
          showToast('info', '该账号已存在（' + (event.account?.label || '已有') + '）');
        } else {
          showToast('success', `已添加账号：${event.account?.label || event.email || '新账号'}`);
        }
        // 传新账号 id 给 onDone，App 只刷新这一个账号的额度（不全量）
        setTimeout(() => onDone(event.account?.id), 800);
        break;
      case 'error':
        setBusy(false);
        cleanup();
        setError(event.message || '流程出错');
        setPhase('error');
        break;
      default:
        break;
    }
  };

  const fail = (msg) => {
    setError(msg || '操作失败');
    setBusy(false);
    setPhase('error');
  };

  const retry = () => {
    cleanup();
    setError('');
    start();
  };

  // 关闭时取消流程（避免后台浏览器残留）
  const handleClose = () => {
    if (phase === 'installing' || phase === 'exchanging' || phase === 'saved') return;
    cleanup();
    window.api.oauthCancel();
    onClose();
  };

  const phaseLabel = {
    checking: '初始化',
    installing: '下载浏览器',
    opening: '打开登录页',
    waiting: '等待登录',
    detected: '已检测到登录',
    exchanging: '保存中',
    saved: '完成',
    error: '出错',
  }[phase] || '';

  return (
    <div className="modal-overlay" onClick={phase === 'installing' || phase === 'exchanging' || phase === 'saved' ? undefined : handleClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>
          <UserPlus size={18} />
          添加账号
          {phaseLabel && <span className="phase-tag">{phaseLabel}</span>}
        </h2>

        {/* 下载 chromium */}
        {phase === 'installing' && (
          <div className="oauth-panel">
            <div className="install-box">
              <Download size={28} className="spin-slow" />
              <strong>首次使用需下载浏览器引擎</strong>
              <span className="progress-msg">{progressMsg}</span>
              <span className="progress-hint">约 170MB，仅下载一次，之后长期复用</span>
            </div>
          </div>
        )}

        {/* checking / opening 通用 loading */}
        {(phase === 'checking' || phase === 'opening') && (
          <div className="oauth-panel">
            <div className="install-box">
              <Loader2 size={28} className="spin" />
              <strong>{progressMsg || '准备中...'}</strong>
            </div>
          </div>
        )}

        {/* 等待用户登录 */}
        {phase === 'waiting' && (
          <div className="oauth-panel">
            <div className="waiting-box">
              <LogIn size={34} />
              <strong>请在弹出的浏览器窗口中登录</strong>
              <span>工具会自动检测登录状态，登录成功后自动完成添加</span>
              <span className="progress-hint">支持账号密码 / 手机号登录（登录后无需做任何操作）</span>
              <Loader2 size={20} className="spin" />
            </div>
          </div>
        )}

        {/* 已检测到登录 / 正在换 token */}
        {(phase === 'detected' || phase === 'exchanging') && (
          <div className="oauth-panel">
            <div className="install-box">
              <ShieldCheck size={28} color="#22c55e" />
              <strong>{phase === 'detected' ? `检测到登录：${email}` : '正在换取 token 并保存...'}</strong>
              {phase === 'exchanging' && <Loader2 size={20} className="spin" />}
              {phase === 'exchanging' && <span className="progress-hint">全程自动化，请稍候</span>}
            </div>
          </div>
        )}

        {/* 成功 */}
        {phase === 'saved' && (
          <div className="oauth-panel">
            <div className="logged-in-box">
              <CheckCircle2 size={32} color="#22c55e" />
              <strong>账号已添加成功</strong>
              {email && <span className="login-email">{email}</span>}
            </div>
          </div>
        )}

        {/* 错误 */}
        {phase === 'error' && (
          <div className="oauth-panel">
            <div className="oauth-error">
              <strong>出错：</strong>{error}
            </div>
          </div>
        )}

        {/* 底部操作 */}
        <div className="modal-actions">
          <button className="btn" onClick={handleClose} disabled={busy}>
            {phase === 'saved' || phase === 'error' ? '关闭' : '取消'}
          </button>
          {phase === 'error' && (
            <button className="btn btn-primary" onClick={retry} disabled={busy}>
              重试
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
