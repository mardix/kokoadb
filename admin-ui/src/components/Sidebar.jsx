import { useEffect, useState } from 'react';
import { useAdmin } from '../context/AdminContext.jsx';
import { KokoaIcon } from './KokoaIcon.jsx';

const databaseSections = [
  { id: 'overview', label: 'Home', icon: 'overview', description: 'Database home' },
  { id: 'crud', label: 'Data', icon: 'data', description: 'Documents and namespaces' },
  { id: 'identity', label: 'Identity', icon: 'identity', description: 'Users and providers' },
  { id: 'files', label: 'Files', icon: 'files', description: 'File metadata' },
  { id: 'sqlite', label: 'SQL', icon: 'sql', description: 'Tables and SQL' },
  { id: 'metrics', label: 'Metrics', icon: 'metrics', description: 'Metric events' },
  { id: 'query', label: 'Query', icon: 'query', description: 'Raw gateway requests' },
  { id: 'stats', label: 'Stats', icon: 'stats', description: 'Database activity' },
  { id: 'admin', label: 'Admin', icon: 'admin', description: 'Database operations' }
];

const instanceSections = [
  { id: 'admin', label: 'System Admin', icon: 'admin', description: 'Instance operations and inventory' },
  { id: 'metrics', label: 'System Metrics', icon: 'stats', description: 'Instance traffic, memory, and queues' },
  { id: 'settings', label: 'Connection', icon: 'connection', description: 'Manage the active connection' }
];

export function Sidebar({ page, setPage, collapsed = false, onToggleCollapsed }) {
  const { status, origin, serviceInfo, activeConnection } = useAdmin();
  const [route, setRoute] = useState(() => parseCrudHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseCrudHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const stage = page === 'crud' ? (route.db ? 'database' : 'host') : 'primary';
  const lastDb = String(activeConnection?.settings?.db || '').trim();

  if (collapsed) {
    return (
      <aside className="sidebar-shell sidebar-shell-collapsed items-center">
        <div className="sidebar-border flex w-full flex-col items-center border-b p-2.5">
          <button type="button" onClick={onToggleCollapsed} className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 transition hover:bg-white/10" title="Expand Sidebar" aria-label="Expand Sidebar">
            <img src="./brand/kokoadb-mark.svg" alt="" className="h-7 w-7 rounded-md" aria-hidden="true" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto p-2.5">
          {stage === 'primary' ? (
            <>
              <CompactButton label="Home" icon="home" active={page === 'home'} onClick={() => setPage('home')} />
              {page !== 'home' ? instanceSections.map((item) => (
                <CompactButton key={item.id} label={item.label} icon={item.icon} active={page === item.id} onClick={() => setPage(item.id)} />
              )) : null}
              {page !== 'home' && lastDb ? <CompactButton label="Return to Database" icon="database" onClick={() => openLastDatabase(lastDb)} /> : null}
            </>
          ) : null}
          {stage === 'host' ? (
            <CompactButton label="Databases" icon="database" active onClick={() => setPage('crud')} />
          ) : null}
          {stage === 'database' ? (
            <>
              {databaseSections.map((item) => (
                <CompactButton key={item.id} label={item.label} icon={item.icon} active={route.tab === item.id} onClick={() => openDbSection(route.db, item.id)} />
              ))}
            </>
          ) : null}
        </nav>
        <div className="sidebar-border flex w-full shrink-0 flex-col items-center gap-2.5 border-t p-2.5">
          {stage === 'database' ? (
            <div className="flex flex-col items-center gap-2 border-b border-white/10 pb-3">
              {instanceSections.map((item) => (
                <CompactButton key={item.id} label={item.label} icon={item.icon} onClick={() => setPage(item.id)} />
              ))}
            </div>
          ) : null}
          <a href={`${origin}/doc`} target="_blank" rel="noreferrer" className="text-[10px] font-semibold text-slate-400 hover:text-sky-300" title="Open KokoaDB Docs">Docs</a>
          <span className="font-mono text-[9px] text-slate-500" title={`KokoaDB ${formatVersion(serviceInfo?.version)}`}>{compactVersion(serviceInfo?.version)}</span>
          <div className={`h-2.5 w-2.5 rounded-full ${statusDot(status.tone)}`} title={status.text} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar-shell">
      <div className="sidebar-border border-b p-3">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={() => setPage('home')} className="flex min-w-0 items-center gap-2 text-left" aria-label="Open KokoaDB Home">
            <img src="./brand/kokoadb-mark.svg" alt="" className="h-8 w-8 shrink-0 rounded-md" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate text-base font-bold tracking-wide text-white">KOKOA<span className="text-cocoa">DB</span></span>
              <span className="mt-0.5 block text-[9px] font-medium uppercase tracking-[0.14em] text-slate-400">Console</span>
            </span>
          </button>
          <button type="button" onClick={onToggleCollapsed} className="rounded-md border border-white/10 px-1.5 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/10 hover:text-white" title="Collapse Sidebar" aria-label="Collapse Sidebar">←</button>
        </div>

        {stage === 'primary' ? (
          <p className="sidebar-muted mt-2.5 text-[11px] leading-4">Choose a connection to begin. No database is opened from this level.</p>
        ) : (
          <div className="mt-3">
            <button type="button" onClick={() => goBack(stage, route.folder)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
              <span aria-hidden="true">←</span>
              {stage === 'database' ? 'All Databases' : route.folder ? 'Previous Folder' : 'All Connections'}
            </button>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2.5">
        {stage === 'primary' ? (
          <div className="space-y-2">
            <div className="sidebar-section">Start</div>
            <SidebarItem icon="home" title="Home" description="Welcome to KokoaDB" active={page === 'home'} onClick={() => setPage('home')} />
            {page !== 'home' ? (
              <>
                <div className="sidebar-section mt-5">Instance</div>
                {instanceSections.map((item) => (
                  <SidebarItem key={item.id} compact icon={item.icon} title={item.label} description={item.description} active={page === item.id} onClick={() => setPage(item.id)} />
                ))}
                {lastDb ? <SidebarItem compact icon="database" title="Return to Database" description={`Open ${lastDb}`} onClick={() => openLastDatabase(lastDb)} /> : null}
              </>
            ) : null}
          </div>
        ) : null}

        {stage === 'host' ? (
          <div className="space-y-2">
            <div className="sidebar-section">Host</div>
            <SidebarItem icon="database" title="Databases" description="Browse and select a database" active onClick={() => setPage('crud')} />
          </div>
        ) : null}

        {stage === 'database' ? (
          <div className="space-y-1">
            <div className="sidebar-section mb-1">Database Workspace</div>
            {databaseSections.map((item) => (
              <SidebarItem compact key={item.id} icon={item.icon} title={item.label} description={item.description} active={route.tab === item.id} onClick={() => openDbSection(route.db, item.id)} />
            ))}
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        {stage === 'database' ? (
          <div className="sidebar-footer-group">
            <div className="sidebar-section mb-1">Instance</div>
            {instanceSections.map((item) => (
              <SidebarItem key={item.id} compact icon={item.icon} title={item.label} description={item.description} active={page === item.id} onClick={() => setPage(item.id)} />
            ))}
          </div>
        ) : null}
        <a href={`${origin}/doc`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white">
          <span>KokoaDB Docs</span>
          <span aria-hidden="true">↗</span>
        </a>
        <div className="mt-2 flex items-center justify-between px-2 text-[11px]"><span className="text-slate-500">Version</span><span className="font-mono text-slate-300">{formatVersion(serviceInfo?.version)}</span></div>
        <div className="mt-2 flex items-center justify-between px-2 text-xs"><span className="text-slate-400">Status</span><span className={statusTone(status.tone)}>{status.text}</span></div>
      </div>
    </aside>
  );
}

function SidebarItem({ icon, title, description, active = false, compact = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`sidebar-menu ${compact ? 'sidebar-menu-compact' : ''} ${active ? 'sidebar-menu-active' : 'sidebar-menu-idle'}`}
      title={compact ? description : undefined}
      aria-label={compact ? `${title}: ${description}` : undefined}
    >
      <div className="flex items-center gap-2">
        {icon ? <KokoaIcon name={icon} className="h-4 w-4 shrink-0" /> : null}
        <div className="min-w-0">
          <div className={compact ? 'truncate text-xs font-medium leading-4' : 'truncate text-[13px] font-medium leading-4'}>{title}</div>
          {!compact ? <div className="mt-0.5 truncate text-[11px] leading-4 text-slate-500">{description}</div> : null}
        </div>
      </div>
    </button>
  );
}

function CompactButton({ label, icon, active = false, onClick }) {
  return <button type="button" onClick={onClick} className={`flex h-9 w-9 items-center justify-center rounded-md text-[11px] font-medium transition ${active ? 'bg-primary-action text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'}`} title={label} aria-label={label}><KokoaIcon name={icon} className="h-4 w-4" /></button>;
}

function goBack(stage, folder = '') {
  if (stage === 'database') {
    window.location.hash = '#crud/home';
    return;
  }
  if (folder) {
    const parts = String(folder).split('/').filter(Boolean);
    parts.pop();
    window.location.hash = parts.length ? `#crud/home/${encodeDbForHash(parts.join('/'))}` : '#crud/home';
    return;
  }
  window.location.hash = '#home';
}

function openLastDatabase(db) {
  if (!db) return;
  window.location.hash = `#crud/db/${encodeDbForHash(db)}/overview`;
}

function openDbSection(db, section) {
  window.location.hash = `#crud/db/${encodeDbForHash(db)}/${section}`;
}

function statusTone(tone) {
  if (tone === 'ready') return 'font-medium text-emerald-300';
  if (tone === 'error') return 'font-medium text-red-300';
  if (tone === 'working') return 'font-medium text-amber-300';
  return 'font-medium text-slate-300';
}

function statusDot(tone) {
  if (tone === 'ready') return 'bg-emerald-300';
  if (tone === 'error') return 'bg-red-300';
  if (tone === 'working') return 'bg-amber-300';
  return 'bg-slate-500';
}

function formatVersion(version) {
  return version ? `v${String(version).replace(/^v/, '')}` : 'Not connected';
}

function compactVersion(version) {
  return version ? `v${String(version).replace(/^v/, '')}` : 'v—';
}

function parseCrudHash(hash) {
  const clean = String(hash || '').replace(/^#/, '');
  const [page, mode, ...rest] = clean.split('/');
  if (page !== 'crud') return { db: '', tab: 'overview' };
  if (mode === 'db' && rest.length) {
    const maybeTab = rest[rest.length - 1];
    const tab = databaseSections.some((item) => item.id === maybeTab) ? maybeTab : 'overview';
    const dbParts = tab === maybeTab ? rest.slice(0, -1) : rest;
    return { db: decodeURIComponent(dbParts.join('/')), tab, folder: '' };
  }
  if (mode === 'home') return { db: '', tab: 'overview', folder: decodeURIComponent(rest.join('/')) };
  return { db: '', tab: 'overview', folder: '' };
}

function encodeDbForHash(db) {
  return String(db || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}
