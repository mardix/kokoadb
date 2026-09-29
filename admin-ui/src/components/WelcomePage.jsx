import { useState } from 'react';
import { useAdmin } from '../context/AdminContext.jsx';

export function WelcomePage({ setPage }) {
  const { connections, activeConnectionId, switchConnection, clearLocalData } = useAdmin();
  const [connectingId, setConnectingId] = useState('');
  const [connectionSearch, setConnectionSearch] = useState('');
  const normalizedSearch = connectionSearch.trim().toLowerCase();
  const visibleConnections = normalizedSearch
    ? connections.filter((connection) => {
      const name = String(connection.settings?.name || 'Connection').toLowerCase();
      const endpoint = connectionEndpoint(connection.settings).toLowerCase();
      return name.includes(normalizedSearch) || endpoint.includes(normalizedSearch);
    })
    : connections;

  async function connect(id) {
    setConnectingId(id);
    const result = await switchConnection(id);
    setConnectingId('');
    if (result) setPage('crud');
  }

  function wipeLocalData() {
    clearLocalData();
    window.location.hash = '#home';
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-5 border-b border-slate-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <img src="./brand/kokoadb-wordmark.svg" alt="KOKOADB" className="h-auto w-full max-w-[230px]" />
          <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">One Database Platform</p>
        </div>
        <button type="button" onClick={() => setPage('settings')} className="btn-primary self-start sm:self-auto">
          {connections.length ? 'Add Connection' : 'Set Up Connection'}
        </button>
      </header>

      <section className="panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-300 p-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="block w-full max-w-md">
            <span className="sr-only">Search Saved Connections</span>
            <input
              value={connectionSearch}
              onChange={(event) => setConnectionSearch(event.target.value)}
              className="field-input"
              placeholder="Search saved connections"
            />
          </label>
          <span className="text-xs font-medium text-slate-500">
            {visibleConnections.length} of {connections.length} saved host{connections.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="hidden grid-cols-[minmax(180px,1fr)_minmax(220px,1.35fr)_90px_110px_64px] gap-4 border-b border-slate-300 bg-slate-50 px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500 md:grid">
          <span>Connection</span>
          <span>Endpoint</span>
          <span>Status</span>
          <span>Added</span>
          <span className="text-right">Action</span>
        </div>

        {visibleConnections.length ? (
          <div className="divide-y divide-slate-200">
            {visibleConnections.map((connection) => {
              const active = connection.id === activeConnectionId;
              const pending = connection.id === connectingId;
              return (
                <article key={connection.id} className={`grid gap-3 px-4 py-3 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1.35fr)_90px_110px_64px] md:items-center md:gap-4 ${active ? 'bg-slate-50/70' : 'bg-white'}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded font-mono text-xs font-bold ${active ? 'bg-slate-800 text-white' : 'border border-slate-300 bg-white text-slate-600'}`} aria-hidden="true">
                      {connectionInitial(connection.settings)}
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold text-slate-900">{connection.settings.name || 'Connection'}</h2>
                      <span className="mt-0.5 block text-[10px] text-slate-500">{active ? 'Active browser connection' : 'Saved connection'}</span>
                    </div>
                  </div>
                  <code className="block truncate text-xs text-slate-600" title={connectionEndpoint(connection.settings)}>{connectionEndpoint(connection.settings)}</code>
                  <span className={`inline-flex w-fit items-center gap-1.5 text-xs font-semibold ${active ? 'text-emerald-700' : 'text-slate-500'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-600' : 'bg-slate-400'}`} aria-hidden="true" />
                    {active ? 'Current' : 'Saved'}
                  </span>
                  <span className="text-xs text-slate-500">{formatConnectionDate(connection.createdAt)}</span>
                  <button type="button" onClick={() => connect(connection.id)} disabled={Boolean(connectingId)} className={active ? 'btn-primary' : 'btn-secondary'}>
                    {pending ? 'Opening...' : active ? 'Open' : 'Connect'}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">{connections.length ? 'No connections match that search' : 'Add your first KOKOADB connection'}</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {connections.length ? 'Try another host name or endpoint.' : 'Enter the full KOKOADB endpoint and an access key when required.'}
              </p>
            </div>
            <button type="button" onClick={() => setPage('settings')} className="btn-primary">{connections.length ? 'Manage Connections' : 'Enter Connection Settings'}</button>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-950">Instance Tools</h2>
          <p className="mt-1 text-xs text-slate-500">Inspect the active instance or manage browser-local console settings.</p>
        </div>
        <div className="panel overflow-hidden">
          <div className="grid md:grid-cols-3">
            <HomeTool title="Connections" description="Add, edit, test, and switch saved KOKOADB hosts." action="Manage Connections" onClick={() => setPage('settings')} />
            <HomeTool title="System Metrics" description="Inspect this instance's uptime, traffic, memory, and background queues." action="View Metrics" onClick={() => setPage('metrics')} />
            <HomeTool title="System Admin" description="Access instance tools, database inventory, and the system catalog." action="Open Admin" onClick={() => setPage('admin')} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 bg-slate-50/70 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-slate-950">Clear Local Console Data</div>
              <div className="mt-1 text-xs text-slate-500">Remove saved connections, cached inventories, request history, and UI preferences from this browser.</div>
            </div>
            <button type="button" onClick={wipeLocalData} className="btn-danger">Clear Local Data</button>
          </div>
        </div>
      </section>
    </section>
  );
}

function HomeTool({ title, description, action, onClick }) {
  return (
    <article className="flex min-h-36 flex-col border-b border-slate-200 p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      <p className="mt-2 flex-1 text-xs leading-5 text-slate-500">{description}</p>
      <button type="button" onClick={onClick} className="mt-4 self-start text-xs font-semibold text-primary hover:underline">{action} <span aria-hidden="true">→</span></button>
    </article>
  );
}

function connectionEndpoint(settings) {
  const server = String(settings?.serverUrl || '').replace(/\/+$/, '');
  const path = `/${String(settings?.basePath || '/_/kdb').replace(/^\/+|\/+$/g, '')}`;
  return `${server}${path}`;
}

function connectionInitial(settings) {
  const name = String(settings?.name || '').trim();
  if (name) return name.charAt(0).toUpperCase();

  try {
    return new URL(String(settings?.serverUrl || '')).hostname.charAt(0).toUpperCase() || 'K';
  } catch {
    return 'K';
  }
}

function formatConnectionDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}
