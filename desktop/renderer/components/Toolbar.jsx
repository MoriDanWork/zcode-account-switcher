import React, { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';

/**
 * 账号列表上方工具栏：搜索 + 多组筛选 + 结果计数
 *
 * props:
 *   search         string          当前搜索词
 *   onSearch       (v)=>void
 *   filters        {scope, health, quota}   各为 'all' | ...
 *   onFilter       (key, value)=>void
 *   total          number          未过滤前的账号总数
 *   shown          number          过滤后显示的账号数
 *   onClearFilters ()=>void        清空搜索 + 所有筛选
 */
export default function Toolbar({
  search,
  onSearch,
  filters = {},
  onFilter,
  total,
  shown,
  onClearFilters,
}) {
  const inputRef = useRef(null);

  // 输入框聚焦时按 / 可快速定位（可选的小快捷键）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasFilters =
    !!search ||
    (filters.health && filters.health !== 'all') ||
    (filters.quota && filters.quota !== 'all');

  return (
    <section className="toolbar" aria-label="搜索与筛选">
      <div className="toolbar-top">
        <div className="search-box">
          <Search size={15} className="search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="搜索名称 / 邮箱 / 提供方"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="搜索账号"
          />
          {search ? (
            <button
              className="search-clear"
              onClick={() => onSearch('')}
              title="清空搜索"
              aria-label="清空搜索"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="results-count" aria-live="polite">
          {hasFilters ? `匹配 ${shown} / ${total} 个账号` : `共 ${total} 个账号`}
        </div>
      </div>

      <div className="toolbar-filters">
        <FilterGroup
          label="健康"
          value={filters.health || 'all'}
          onChange={(v) => onFilter('health', v)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'healthy', label: '健康' },
            { value: 'warning', label: '注意' },
            { value: 'error', label: '异常' },
          ]}
        />
        <FilterGroup
          label="额度"
          value={filters.quota || 'all'}
          onChange={(v) => onFilter('quota', v)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'available', label: '可查' },
            { value: 'unavailable', label: '不可查' },
          ]}
        />
        {hasFilters ? (
          <button className="filter-clear" onClick={onClearFilters} aria-label="清空搜索与筛选条件">
            <X size={13} />
            清空筛选
          </button>
        ) : null}
      </div>
    </section>
  );
}

function FilterGroup({ label, value, onChange, options }) {
  return (
    <div className="filter-group" role="group" aria-label={label}>
      <span className="filter-label">{label}</span>
      <div className="segmented">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`segment ${value === opt.value ? 'active' : ''}`}
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
