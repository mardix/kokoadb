import { useMemo, useState } from 'react';

export function DataBrowserFrame({
  label,
  items,
  selected,
  onSelect,
  searchPlaceholder = 'Filter items...',
  emptyMessage = 'Nothing to display.',
  children
}) {
  const [search, setSearch] = useState('');
  const visibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term
      ? items.filter((item) => String(item.label || item.id).toLowerCase().includes(term))
      : items;
  }, [items, search]);

  return (
    <section className="data-browser-frame">
      <aside className="data-browser-rail">
        <div className="data-browser-rail-header">
          <div>
            <h3>{label}</h3>
            <p>{items.length} available</p>
          </div>
        </div>
        <div className="data-browser-search-wrap">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="data-browser-search"
            placeholder={searchPlaceholder}
            aria-label={`Filter ${label}`}
          />
        </div>
        <nav className="data-browser-list" aria-label={label}>
          {visibleItems.length ? visibleItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={`data-browser-item ${selected === item.id ? 'data-browser-item-active' : ''}`}
            >
              <span className="data-browser-item-icon" aria-hidden="true">{item.icon || '▦'}</span>
              <span className="data-browser-item-label" title={item.label}>{item.label}</span>
              {item.count !== undefined && item.count !== null ? <span className="data-browser-item-count">{formatCompact(item.count)}</span> : null}
            </button>
          )) : <p className="data-browser-empty">{emptyMessage}</p>}
        </nav>
      </aside>
      <div className="data-browser-content">{children}</div>
    </section>
  );
}

export function DataBrowserTabs({ label, tabs, active, onChange, actions = null }) {
  return (
    <section className="data-browser-tabs-bar">
      <div className="data-browser-tabs-title">{label}</div>
      <div className="data-browser-tabs" role="tablist" aria-label={`${label} views`}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => onChange(tab.id)}
            className={`data-browser-tab ${active === tab.id ? 'data-browser-tab-active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {actions ? <div className="data-browser-tabs-actions">{actions}</div> : null}
    </section>
  );
}

function formatCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
}
