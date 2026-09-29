import { useEffect, useState } from 'react';
import { ResponsePanel } from './ResponsePanel.jsx';

export function FtsIndexPanel({ db, gateway, runStatusCall, showToast }) {
  const [response, setResponse] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  useEffect(() => {
    if (!db) return;
    const timer = window.setTimeout(() => void loadIndexStatus(true), 0);
    return () => window.clearTimeout(timer);
    // Refresh when the active database changes; gateway functions are stable context values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  async function loadIndexStatus(silent = false) {
    const runner = async () => {
      const started = performance.now();
      const [config, indexes, jobs] = await Promise.all([
        gateway({ db, operation: 'get_system_config', payload: {} }),
        gateway({ db, operation: 'list_indexes', payload: {} }),
        gateway({ db, operation: 'list_jobs', payload: { job_type: 'reindex_fts', limit: 10 } })
      ]);
      const data = {
        status: 'success',
        data: {
          config: config?.data,
          indexes: indexes?.data,
          recent_reindex_jobs: jobs?.data
        }
      };
      setResponse(data);
      setDurationMs(performance.now() - started);
      return data;
    };

    if (silent) {
      try {
        return await runner();
      } catch (_) {
        return null;
      }
    }
    return runStatusCall(runner);
  }

  async function runIndexOperation(operation, payload, message) {
    await runStatusCall(async () => {
      const started = performance.now();
      const data = await gateway({ db, operation, payload });
      setDurationMs(performance.now() - started);
      setResponse(data);
      showToast(message);
      return data;
    });
  }

  return (
    <section className="space-y-4">
      <section className="panel">
        <div className="panel-header-row">
          <div>
            <h3 className="text-sm font-semibold text-slate-950">FTS5 Index Lifecycle</h3>
            <p className="text-xs text-slate-500">Document search uses the normal query operation with payload.search. Manage only index access and lifecycle here.</p>
          </div>
          <button type="button" onClick={() => loadIndexStatus()} className="btn-secondary">Refresh Status</button>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <IndexAction title="Enable Access" description="Allow query requests containing payload.search." onClick={() => runIndexOperation('enable_fts_index', { enable: true }, 'FTS access enabled')} />
          <IndexAction title="Disable Access" description="Block FTS5 search without deleting indexed data." onClick={() => runIndexOperation('enable_fts_index', { enable: false }, 'FTS access disabled')} />
          <IndexAction title="Reindex" description="Queue creation and backfill of the FTS5 index." onClick={() => runIndexOperation('reindex_fts', {}, 'FTS reindex queued')} primary />
          <IndexAction title="Drop Index" description="Queue removal of FTS5 index data and triggers." onClick={() => runIndexOperation('drop_fts_index', {}, 'FTS index drop queued')} danger />
        </div>
      </section>
      <ResponsePanel title="FTS5 Status" data={response} durationMs={durationMs} />
    </section>
  );
}

function IndexAction({ title, description, onClick, primary = false, danger = false }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <h4 className="text-sm font-semibold text-slate-950">{title}</h4>
      <p className="mt-1 min-h-10 text-xs leading-5 text-slate-500">{description}</p>
      <button type="button" onClick={onClick} className={danger ? 'btn-danger mt-3 w-full' : primary ? 'btn-primary mt-3 w-full' : 'btn-secondary mt-3 w-full'}>{title}</button>
    </div>
  );
}
