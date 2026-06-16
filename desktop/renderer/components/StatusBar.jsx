import React from 'react';
import { RefreshCw } from 'lucide-react';

function formatNumber(value) {
  if (value == null) return '未知';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

/**
 * 顶部状态概览：当前账号 + ZCode 运行状态 + 总额度
 */
export default function StatusBar({ status, loading, quota, quotaLoading, onRefreshQuota, currentQuota }) {
  const cur = status?.current;
  const running = status?.zcodeRunning;

  // 当前账号额度摘要：取所有模型剩余合计 + 整体剩余比例
  const curQ = currentQuota?.ok && currentQuota?.data;
  const curItems = curQ?.items || [];
  const curSumRemaining = curItems.reduce((a, b) => a + (b.remaining || 0), 0);
  const curSumTotal = curItems.reduce((a, b) => a + (b.total || 0), 0);
  const curSumUsed = curItems.reduce((a, b) => a + (b.used || 0), 0);
  // 整体剩余比例（满额度→满条）
  const curRemainingPct = curSumTotal > 0 ? Math.max(0, Math.min(100, (1 - curSumUsed / curSumTotal) * 100)) : null;

  return (
    <section className="overview-grid" aria-label="当前状态概览">
      <div className="overview-card identity-card">
        <div className="identity-head">
          <div className="identity-avatar">
            {cur?.avatar ? <img src={cur.avatar} alt="" /> : <span>{(cur?.email || cur?.label || '?').slice(0, 1).toUpperCase()}</span>}
          </div>
          <div className="identity-copy">
            <span className="eyebrow">当前账号</span>
            {loading ? (
              <strong>读取中…</strong>
            ) : cur ? (
              <strong>{cur.email || cur.label || cur.name}</strong>
            ) : (
              <strong className="warn-text">未识别（可能未登录）</strong>
            )}
          </div>
        </div>
        {cur && !loading && (
          currentQuota?.loading ? (
            <div className="quota-empty">额度加载中…</div>
          ) : curItems.length > 0 ? (
            <div className="overview-quota-items">
              {curItems.map((item, idx) => {
                const remainingPct = item.percentUsed == null
                  ? 100
                  : Math.max(0, Math.min(100, 100 - item.percentUsed));
                return (
                  <div className="overview-quota-item" key={idx} title={`${item.name}：剩 ${formatNumber(item.remaining)} / 总 ${formatNumber(item.total)}`}>
                    <div className="overview-quota-item-head">
                      <span className="overview-quota-item-name">{item.name}</span>
                      <span className="overview-quota-item-pct">{item.percentUsed == null ? '—' : '剩 ' + remainingPct.toFixed(0) + '%'}</span>
                    </div>
                    <div
                      className="quota-bar"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(remainingPct)}
                      aria-label={`${item.name} 剩余额度 ${remainingPct.toFixed(0)}%`}
                    >
                      <span style={{ width: `${remainingPct}%` }} />
                    </div>
                    <div className="overview-quota-item-stats">
                      <span>剩 {formatNumber(item.remaining)}</span>
                      <span>总 {formatNumber(item.total)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : currentQuota?.error ? (
            <div className="quota-empty">额度不可查</div>
          ) : (
            <div className="quota-empty">暂无额度数据</div>
          )
        )}
      </div>

      <div className="overview-card quota-card">
        <div className="quota-head">
          <div>
            <span className="eyebrow">总额度概览</span>
            <strong>{quota?.isEmpty ? '暂无计费数据' : (quota?.display?.remaining || '未知') + ' 可用'}</strong>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onRefreshQuota} disabled={quotaLoading} title="刷新额度" aria-label="刷新额度">
            <RefreshCw size={15} className={quotaLoading ? 'spin' : ''} />
          </button>
        </div>
        {quota?.isEmpty || !quota?.items?.length ? (
          <div className="quota-empty">暂无计费数据</div>
        ) : (
          <div className="overview-quota-items">
            {quota.items.map((item, idx) => {
              // 进度条语义：剩余额度比例（满额度→满条，用到 0→空条）
              // percentUsed 为 null（无法计算）时，有额度数据则按满格显示
              const remainingPct = item.percentUsed == null
                ? 100
                : Math.max(0, Math.min(100, 100 - item.percentUsed));
              return (
                <div className="overview-quota-item" key={idx}>
                  <div className="overview-quota-item-head">
                    <span className="overview-quota-item-name">{item.name}</span>
                    <span className="overview-quota-item-pct">{item.percentUsed == null ? '—' : '剩 ' + remainingPct.toFixed(0) + '%'}</span>
                  </div>
                  <div
                    className="quota-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(remainingPct)}
                    aria-label={`${item.name} 剩余额度 ${remainingPct.toFixed(0)}%`}
                  >
                    <span style={{ width: `${remainingPct}%` }} />
                  </div>
                  <div className="overview-quota-item-stats">
                    <span>剩 {formatNumber(item.remaining)}</span>
                    <span>总 {formatNumber(item.total)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="overview-card runtime-card">
        <span className="eyebrow">运行状态</span>
        <strong>
          <span className={`status-dot ${running ? 'on' : 'off'}`} />
          ZCode {running ? '运行中' : '未运行'}
        </strong>
        <div className="runtime-foot">
          <div className="foot-row">
            <span className="foot-label">可回滚备份</span>
            <span>{status?.hasLastBackup ? '有' : '无'}</span>
          </div>
          <div className="foot-row">
            <span className="foot-label">当前账号</span>
            <span className="foot-email" title={status?.current?.email || status?.current?.label}>
              {status?.current ? (status.current.email || status.current.label || '-') : '-'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
