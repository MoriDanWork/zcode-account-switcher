import React, { useState, useEffect, useRef } from 'react';
import { UserPlus, Loader2 } from 'lucide-react';

/**
 * 捕获新账号弹窗
 */
export default function CaptureModal({ onClose, onConfirm, busy, defaultName }) {
  const [name, setName] = useState(defaultName || '');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => onConfirm(name.trim() || defaultName);

  const handleKey = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          <UserPlus size={18} />
          捕获当前账号
        </h2>
        <p>
          把 ZCode 当前登录的账号存为一个快照，之后可一键切换回来，无需重新登录。
        </p>
        <input
          ref={inputRef}
          className="modal-input"
          placeholder="给这个账号起个名字（如：主账号）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKey}
          disabled={busy}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <UserPlus size={15} />}
            捕获
          </button>
        </div>
      </div>
    </div>
  );
}
