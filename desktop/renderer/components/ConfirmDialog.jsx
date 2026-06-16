import React, { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * 通用二次确认弹窗
 * - Esc 取消，Enter（非危险操作时）确认
 * - 打开时聚焦「取消」避免误触；危险操作聚焦「取消」更安全
 */
export default function ConfirmDialog({ title, desc, detail, danger, confirmText, cancelText, onCancel, onOk, wide }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={danger ? { color: '#ef4444' } : undefined}>
          <AlertTriangle size={18} />
          {title}
        </h2>
        <p>{desc}</p>
        {detail ? <div className="confirm-detail">{detail}</div> : null}
        <div className="modal-actions">
          <button className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelText || '取消'}
          </button>
          <button
            className={danger ? 'btn' : 'btn btn-primary'}
            onClick={onOk}
            style={
              danger
                ? { background: '#ef4444', color: '#fff', fontWeight: 600 }
                : undefined
            }
          >
            {confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
