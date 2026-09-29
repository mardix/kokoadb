import { useEffect, useState } from 'react';
import { useAdmin } from '../context/AdminContext.jsx';
import { defaultMetricForm, metricPayloadFromForm } from '../lib/presets.js';
import { aliasFromField, pretty, titleFromAlias, tryParseJson } from '../lib/format.js';
import { Field } from './SettingsPanel.jsx';
import { JsonEditor, formatJsonText } from './JsonEditor.jsx';
import { PageHeader } from './Layout.jsx';
import { ResponsePanel } from './ResponsePanel.jsx';
import { DataBrowserFrame, DataBrowserTabs } from './DataBrowserFrame.jsx';

const modes = [
  { id: 'query', label: 'Data' },
  { id: 'ingest', label: 'Ingest' },
  { id: 'raw', label: 'Raw' }
];

const sampleEvents = [
  {
    event: 'api.request',
    ts: { '@@now': true },
    value: 1,
    dimensions: { endpoint: '/v1/gateway', method: 'POST', status: 200, duration_ms: 42 }
  }
];

const quickRanges = ['1h', '6h', '24h', '7d', '30d', 'today', 'yesterday', 'this_week', 'this_month'];
const quickIntervals = ['minute', 'hour', 'day', 'week', 'month'];

export function MetricsEventsConsole() {
  return <MetricsEventsPanel />;
}

export function MetricsEventsPanel({ embedded = false, db }) {
  const { settings, gateway, runStatusCall, showToast } = useAdmin();
  const activeDb = db || settings.db;
  const [mode, setMode] = useState('query');
  const [form, setForm] = useState(defaultMetricForm);
  const [queryPreview, setQueryPreview] = useState(() => pretty({ db: activeDb, operation: 'metrics_query', payload: metricPayloadFromForm(defaultMetricForm()) }));
  const [ingestText, setIngestText] = useState(() => pretty(sampleEvents));
  const [rawText, setRawText] = useState(() => pretty({ db: activeDb, operation: 'metrics_query', payload: metricPayloadFromForm(defaultMetricForm()) }));
  const [response, setResponse] = useState(null);
  const [responseDurationMs, setResponseDurationMs] = useState(null);
  const [catalogEvents, setCatalogEvents] = useState([]);
  const [catalogDimensions, setCatalogDimensions] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');

  useEffect(() => {
    const request = { db: activeDb, operation: 'metrics_query', payload: metricPayloadFromForm(form) };
    setQueryPreview(pretty(request));
    setRawText((prev) => {
      const [parsed] = tryParseJson(prev);
      if (parsed?.operation && parsed.operation !== 'metrics_query') return prev;
      return pretty(request);
    });
  }, [activeDb, form]);

  useEffect(() => {
    if (!activeDb) return;
    void loadCatalogEvents();
  }, [activeDb]);

  useEffect(() => {
    if (!activeDb || !form.event) {
      setCatalogDimensions([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void loadCatalogDimensions(form.event);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [activeDb, form.event]);

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function loadCatalogEvents() {
    if (!activeDb) return;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const data = await gateway({ db: activeDb, operation: 'metrics_catalog', payload: { type: 'event', limit: 500 } });
      setCatalogEvents(catalogValues(data));
    } catch (error) {
      setCatalogError(error.message || 'Unable to load metrics catalog');
    } finally {
      setCatalogLoading(false);
    }
  }

  async function loadCatalogDimensions(eventName) {
    if (!activeDb || !eventName) return;
    setCatalogError('');
    try {
      const data = await gateway({ db: activeDb, operation: 'metrics_catalog', payload: { type: 'dimension', name: eventName, limit: 500 } });
      setCatalogDimensions(catalogValues(data));
    } catch (error) {
      setCatalogDimensions([]);
      setCatalogError(error.message || 'Unable to load event dimensions');
    }
  }

  function selectEvent(eventName) {
    update('event', eventName);
  }

  function addGroup(field) {
    setForm((prev) => ({ ...prev, groups: addCsvValue(prev.groups, field) }));
  }

  function addMetric(op, field) {
    setForm((prev) => ({ ...prev, metrics: addMetricToText(prev.metrics, op, field) }));
  }

  function applyQuickRange(range) {
    setForm((prev) => ({ ...prev, rangeMode: 'preset', range }));
  }

  function resetSample() {
    const next = defaultMetricForm();
    const request = { db: activeDb, operation: 'metrics_query', payload: metricPayloadFromForm(next) };
    setForm(next);
    setQueryPreview(pretty(request));
    setRawText(pretty(request));
    setIngestText(pretty(sampleEvents));
  }

  function buildQueryRequest() {
    try {
      if (!activeDb) {
        showToast('Select a DB first', true);
        return null;
      }
      const request = { db: activeDb, operation: 'metrics_query', payload: metricPayloadFromForm(form) };
      setQueryPreview(pretty(request));
      return request;
    } catch (error) {
      showToast(`Invalid metrics/filter JSON: ${error.message}`, true);
      return null;
    }
  }

  function buildIngestRequest() {
    const [events, error] = tryParseJson(ingestText);
    if (error) {
      showToast(`Invalid events JSON: ${error.message}`, true);
      return null;
    }
    if (!Array.isArray(events) || !events.length) {
      showToast('Ingest requires a non-empty events array', true);
      return null;
    }
    return { db: activeDb, operation: 'metrics_ingest', payload: { events, commit: false } };
  }

  function buildRawRequest() {
    const [request, error] = tryParseJson(rawText);
    if (error) {
      showToast(`Invalid raw request JSON: ${error.message}`, true);
      return null;
    }
    request.db = activeDb;
    return request;
  }

  async function runRequest(request) {
    if (!request) return;
    await runStatusCall(async () => {
      const startedAt = performance.now();
      const data = await gateway(request);
      setResponse(data);
      setResponseDurationMs(performance.now() - startedAt);
      if (request.operation === 'metrics_ingest') {
        void loadCatalogEvents();
        void loadCatalogDimensions(form.event);
      }
      return data;
    });
  }

  async function copyRequest(request) {
    if (!request) return;
    await navigator.clipboard.writeText(pretty(request));
    showToast('Metrics request copied');
  }

  function formatRaw() {
    try {
      setRawText(formatJsonText(rawText));
    } catch (error) {
      showToast(`Invalid raw request JSON: ${error.message}`, true);
    }
  }

  return (
    <section className="space-y-4">
      {embedded ? (
        <MetricsModeHeader mode={mode} onMode={setMode} />
      ) : (
        <PageHeader
          eyebrow="Metrics"
          title="Metrics Console"
          description="Query and ingest metric events for the selected database."
          actions={<button onClick={resetSample} className="btn-secondary">Sample</button>}
        />
      )}

      {!embedded ? <MetricsModeHeader mode={mode} onMode={setMode} /> : null}

      {mode === 'query' ? (
        <MetricsQueryMode
          form={form}
          requestPreview={queryPreview}
          catalogEvents={catalogEvents}
          catalogDimensions={catalogDimensions}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          onChange={update}
          onSelectEvent={selectEvent}
          onAddGroup={addGroup}
          onAddMetric={addMetric}
          onQuickRange={applyQuickRange}
          onRefreshCatalog={loadCatalogEvents}
          onCopy={() => copyRequest(buildQueryRequest())}
          onPreview={buildQueryRequest}
          onRun={() => runRequest(buildQueryRequest())}
          response={response}
          responseDurationMs={responseDurationMs}
        />
      ) : null}

      {mode === 'ingest' ? (
        <MetricsIngestMode
          value={ingestText}
          event={form.event}
          onUseEvent={selectEvent}
          catalogEvents={catalogEvents}
          onChange={setIngestText}
          onCopy={() => copyRequest(buildIngestRequest())}
          onRun={() => runRequest(buildIngestRequest())}
        />
      ) : null}

      {mode === 'raw' ? (
        <MetricsRawMode
          value={rawText}
          onChange={setRawText}
          onCopy={() => copyRequest(buildRawRequest())}
          onFormat={formatRaw}
          onRun={() => runRequest(buildRawRequest())}
        />
      ) : null}

      {mode !== 'query' ? <ResponsePanel title="Metrics Response" data={response} metrics durationMs={responseDurationMs} /> : null}
    </section>
  );
}

function MetricsQueryMode({
  form,
  requestPreview,
  catalogEvents,
  catalogDimensions,
  catalogLoading,
  catalogError,
  onChange,
  onSelectEvent,
  onAddGroup,
  onAddMetric,
  onQuickRange,
  onRefreshCatalog,
  onCopy,
  onPreview,
  onRun,
  response,
  responseDurationMs
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [metricsRawOpen, setMetricsRawOpen] = useState(false);
  const [filterRawOpen, setFilterRawOpen] = useState(false);
  const [groupInput, setGroupInput] = useState('');

  function commitGroupInput() {
    const value = groupInput.trim();
    if (!value) return;
    onAddGroup(value);
    setGroupInput('');
  }

  function removeGroup(field) {
    onChange('groups', removeCsvValue(form.groups, field));
  }

  return (
    <DataBrowserFrame
      label="Metric Events"
      items={[
        { id: '__all', label: 'All Metrics', count: catalogEvents.length, icon: '◫' },
        ...catalogEvents.map((eventName) => ({ id: eventName, label: eventName, icon: '∿' }))
      ]}
      selected={form.event || '__all'}
      onSelect={(eventName) => onSelectEvent(eventName === '__all' ? '' : eventName)}
      searchPlaceholder="Filter event types..."
      emptyMessage="No metric events discovered yet."
    >
      <div className="metrics-data-grid h-full overflow-auto">
        <div className="min-w-0 space-y-3">
          <section className="panel metrics-explorer-summary">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold text-slate-950">{form.event || 'All Metrics'}</h3>
                <span className="badge badge-info">{form.rangeMode === 'custom' ? 'Custom Range' : form.range}</span>
                <span className="badge badge-muted">By {titleFromAlias(form.interval || 'none')}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Explore the current event and refine its query from the inspector.</p>
            </div>
            <button type="button" onClick={onRun} disabled={!form.event} className="btn-primary shrink-0">Run Query</button>
          </section>

          {!form.event ? (
            <MetricsCatalogTable events={catalogEvents} loading={catalogLoading} error={catalogError} onSelect={onSelectEvent} onRefresh={onRefreshCatalog} />
          ) : response ? (
            <ResponsePanel title="Metrics Results" data={response} metrics durationMs={responseDurationMs} />
          ) : (
            <section className="panel metrics-empty-results">
              <div className="max-w-lg text-center">
                <h3 className="text-base font-semibold text-slate-900">{form.event ? 'Explore this event' : 'Select a metric event'}</h3>
                <p className="mt-2 text-sm text-slate-500">Choose an event from the left, configure metrics and filters, then run the query to populate the table.</p>
                {form.event ? <button type="button" onClick={onRun} className="btn-primary mt-4">Run Query</button> : null}
              </div>
            </section>
          )}
        </div>

        <MetricsQueryInspector
          form={form}
          requestPreview={requestPreview}
          previewOpen={previewOpen}
          metricsRawOpen={metricsRawOpen}
          filterRawOpen={filterRawOpen}
          groupInput={groupInput}
          onChange={onChange}
          onQuickRange={onQuickRange}
          onPreview={() => {
            if (!onPreview()) return;
            setPreviewOpen((value) => !value);
          }}
          onCopy={onCopy}
          onRun={onRun}
          onMetricsRawOpen={setMetricsRawOpen}
          onFilterRawOpen={setFilterRawOpen}
          onGroupInput={setGroupInput}
          onGroupCommit={commitGroupInput}
          onGroupRemove={removeGroup}
        />
      </div>
    </DataBrowserFrame>
  );
}

function MetricsCatalogTable({ events, loading, error, onSelect, onRefresh }) {
  return (
    <section className="panel overflow-hidden">
      <div className="panel-header-row">
        <div>
          <h3 className="panel-title">Metric Event Types</h3>
          <p className="panel-subtitle">Choose an event to inspect its time-series metrics and dimensions.</p>
        </div>
        <button type="button" onClick={onRefresh} className="btn-secondary">Refresh</button>
      </div>
      {error ? <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      <div className="overflow-x-auto">
        <table className="data-grid min-w-full">
          <thead>
            <tr>
              <th className="data-grid-head w-16">#</th>
              <th className="data-grid-head">Event Type</th>
              <th className="data-grid-head w-32 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {events.map((eventName, index) => (
              <tr key={eventName}>
                <td className="data-grid-cell text-slate-400">{index + 1}</td>
                <td className="data-grid-cell font-mono font-medium text-slate-900">{eventName}</td>
                <td className="data-grid-cell text-right"><button type="button" className="btn-label" onClick={() => onSelect(eventName)}>Open</button></td>
              </tr>
            ))}
            {!events.length ? (
              <tr><td colSpan="3" className="data-grid-cell py-10 text-center text-sm text-slate-500">{loading ? 'Loading metric events...' : 'No metric events discovered yet.'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricsQueryInspector({
  form,
  requestPreview,
  previewOpen,
  metricsRawOpen,
  filterRawOpen,
  groupInput,
  onChange,
  onQuickRange,
  onPreview,
  onCopy,
  onRun,
  onMetricsRawOpen,
  onFilterRawOpen,
  onGroupInput,
  onGroupCommit,
  onGroupRemove
}) {
  return (
    <aside className="panel metrics-query-inspector">
      <div className="panel-header-row">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Query Inspector</h3>
          <p className="text-xs text-slate-500">Configure the active query.</p>
        </div>
        <button type="button" onClick={onPreview} className="btn-panel-menu">{previewOpen ? 'Inspector' : 'Request'}</button>
      </div>

      {previewOpen ? (
        <div className="space-y-3 p-3">
          <div>
            <div className="field-label">Request Preview</div>
            <pre className="metrics-request-preview">{requestPreview}</pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onCopy} className="btn-secondary">Copy Request</button>
            <button type="button" onClick={onRun} className="btn-primary">Run Query</button>
          </div>
        </div>
      ) : (
        <>
          <InspectorSection title="Event">
            <Field label="Event Name" value={form.event} onChange={(value) => onChange('event', value)} placeholder="api.request" />
          </InspectorSection>
          <InspectorSection title="Time Window">
            <CompactTimeControls form={form} onChange={onChange} onQuickRange={onQuickRange} />
          </InspectorSection>
          <InspectorSection title="Metrics" action={<button type="button" onClick={() => onMetricsRawOpen(!metricsRawOpen)} className="btn-label">{metricsRawOpen ? 'Wizard' : 'JSON'}</button>}>
            <CompactMetricsEditor value={form.metrics} rawOpen={metricsRawOpen} onChange={(value) => onChange('metrics', value)} />
          </InspectorSection>
          <InspectorSection title="Group By">
            <GroupByBuilder groups={csvValues(form.groups)} value={groupInput} onInput={onGroupInput} onCommit={onGroupCommit} onRemove={onGroupRemove} />
          </InspectorSection>
          <InspectorSection title="Filters" action={<button type="button" onClick={() => onFilterRawOpen(!filterRawOpen)} className="btn-label">{filterRawOpen ? 'Wizard' : 'JSON'}</button>}>
            <CompactFilterEditor value={form.filter} rawOpen={filterRawOpen} onChange={(value) => onChange('filter', value)} />
          </InspectorSection>
          <div className="metrics-inspector-actions"><button type="button" onClick={onRun} className="btn-primary w-full">Apply & Run Query</button></div>
        </>
      )}
    </aside>
  );
}

function InspectorSection({ title, action = null, children }) {
  return (
    <section className="metrics-inspector-section">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function CompactTimeControls({ form, onChange, onQuickRange }) {
  const custom = form.rangeMode === 'custom';
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="field-label">Mode</span>
        <select value={form.rangeMode || 'preset'} onChange={(event) => onChange('rangeMode', event.target.value)} className="mini-select"><option value="preset">Preset Range</option><option value="custom">Custom Dates</option></select>
      </label>
      {custom ? (
        <div className="space-y-2">
          <label className="block"><span className="field-label">Start</span><input type="datetime-local" value={form.start || ''} onChange={(event) => onChange('start', event.target.value)} className="mini-input" /></label>
          <label className="block"><span className="field-label">End</span><input type="datetime-local" value={form.end || ''} onChange={(event) => onChange('end', event.target.value)} className="mini-input" /></label>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">{quickRanges.map((range) => <button key={range} type="button" onClick={() => onQuickRange(range)} className={`btn-label ${form.range === range ? 'btn-chip-secondary' : ''}`}>{range}</button>)}</div>
      )}
      <div>
        <div className="field-label">Interval</div>
        <div className="flex flex-wrap gap-1.5">{quickIntervals.map((interval) => <button key={interval} type="button" onClick={() => onChange('interval', interval)} className={`btn-label ${form.interval === interval ? 'btn-chip-secondary' : ''}`}>{titleFromAlias(interval)}</button>)}</div>
      </div>
    </div>
  );
}

function CompactMetricsEditor({ value, rawOpen, onChange }) {
  const metrics = parseMetrics(value);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ op: 'count', field: '*', alias: 'events', label: 'Events' });

  function addMetric() {
    const field = draft.field.trim() || '*';
    const op = draft.op || 'count';
    const alias = draft.alias.trim() || metricAlias(op, field);
    onChange(pretty([...metrics, { op, field, alias, label: draft.label.trim() || titleFromAlias(alias) }]));
    setDraft({ op: 'count', field: '*', alias: 'events', label: 'Events' });
    setAdding(false);
  }

  if (rawOpen) return <JsonEditor value={value} onChange={onChange} minHeight="190px" />;
  return (
    <div className="space-y-2">
      {metrics.map((metric, index) => (
        <div key={`${metric.alias || metric.field}-${index}`} className="metrics-inspector-item">
          <div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-800">{metric.label || metric.alias || metric.op}</div><div className="truncate text-[11px] text-slate-500">{metric.op} · {metric.field || '*'}</div></div>
          <button type="button" onClick={() => onChange(pretty(metrics.filter((_, itemIndex) => itemIndex !== index)))} className="metrics-remove-button" aria-label={`Remove ${metric.alias || metric.field || 'metric'}`}>×</button>
        </div>
      ))}
      {adding ? (
        <div className="metrics-inspector-editor">
          <label><span className="field-label">Operation</span><select value={draft.op} onChange={(event) => setDraft((previous) => ({ ...previous, op: event.target.value }))} className="mini-select"><option value="count">Count</option><option value="sum">Sum</option><option value="avg">Average</option><option value="min">Minimum</option><option value="max">Maximum</option></select></label>
          <Field label="Field" value={draft.field} onChange={(field) => setDraft((previous) => ({ ...previous, field }))} placeholder="* or duration_ms" />
          <Field label="Alias" value={draft.alias} onChange={(alias) => setDraft((previous) => ({ ...previous, alias }))} placeholder="requests" />
          <Field label="Label" value={draft.label} onChange={(label) => setDraft((previous) => ({ ...previous, label }))} placeholder="Requests" />
          <div className="flex gap-2"><button type="button" onClick={addMetric} className="btn-primary">Add</button><button type="button" onClick={() => setAdding(false)} className="btn-secondary">Cancel</button></div>
        </div>
      ) : <button type="button" onClick={() => setAdding(true)} className="btn-secondary w-full">Add Metric</button>}
    </div>
  );
}

function CompactFilterEditor({ value, rawOpen, onChange }) {
  const rows = filterRowsFromJson(value);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ field: '', op: '$eq', value: '' });

  function addFilter() {
    if (!draft.field.trim()) return;
    onChange(pretty(filterJsonFromRows([...rows, draft])));
    setDraft({ field: '', op: '$eq', value: '' });
    setAdding(false);
  }

  if (rawOpen) return <JsonEditor value={value} onChange={onChange} minHeight="170px" />;
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${row.field}-${index}`} className="metrics-inspector-item">
          <div className="min-w-0 truncate text-xs text-slate-700"><span className="font-semibold">{row.field}</span> <span className="text-slate-500">{row.op}</span> {row.value}</div>
          <button type="button" onClick={() => onChange(pretty(filterJsonFromRows(rows.filter((_, itemIndex) => itemIndex !== index))))} className="metrics-remove-button" aria-label={`Remove ${row.field || 'filter'}`}>×</button>
        </div>
      ))}
      {adding ? (
        <div className="metrics-inspector-editor">
          <Field label="Field" value={draft.field} onChange={(field) => setDraft((previous) => ({ ...previous, field }))} placeholder="dimensions.status" />
          <label><span className="field-label">Operator</span><select value={draft.op} onChange={(event) => setDraft((previous) => ({ ...previous, op: event.target.value }))} className="mini-select"><option value="$eq">Equals</option><option value="$ne">Not Equal</option><option value="$gt">Greater Than</option><option value="$gte">At Least</option><option value="$lt">Less Than</option><option value="$lte">At Most</option><option value="$in">In List</option></select></label>
          <Field label="Value" value={draft.value} onChange={(nextValue) => setDraft((previous) => ({ ...previous, value: nextValue }))} placeholder="200 or [200, 201]" />
          <div className="flex gap-2"><button type="button" onClick={addFilter} className="btn-primary">Add</button><button type="button" onClick={() => setAdding(false)} className="btn-secondary">Cancel</button></div>
        </div>
      ) : <button type="button" onClick={() => setAdding(true)} className="btn-secondary w-full">Add Filter</button>}
    </div>
  );
}

function MetricsModeHeader({ mode, onMode }) {
  return (
    <DataBrowserTabs label="Metrics" tabs={modes} active={mode} onChange={onMode} />
  );
}

function GroupByBuilder({ groups, value, onInput, onCommit, onRemove }) {
  return (
    <label className="block">
      <span className="field-label">Group By</span>
      <div className="rounded-lg border border-slate-300 bg-white p-2 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20">
        <div className="flex flex-wrap gap-2">
          {groups.map((group) => (
            <span key={group} className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
              {group}
              <button type="button" onClick={() => onRemove(group)} className="text-slate-400 hover:text-rose-600" aria-label={`Remove ${group}`}>X</button>
            </span>
          ))}
          <input
            value={value}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                onCommit();
              }
            }}
            onBlur={onCommit}
            placeholder={groups.length ? 'Add another path...' : 'dimensions.endpoint'}
            className="min-w-24 flex-1 border-0 bg-transparent px-1 py-1 text-sm outline-none"
          />
        </div>
      </div>
    </label>
  );
}

function MetricsCatalogPanel({ events, dimensions, selectedEvent, loading, error, onSelectEvent, onAddGroup, onAddMetric, onRefresh }) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const visibleEvents = term ? events.filter((value) => value.toLowerCase().includes(term)) : events;
  const visibleDimensions = term ? dimensions.filter((value) => value.toLowerCase().includes(term)) : dimensions;

  return (
    <section className="panel metrics-catalog-panel">
      <div className="panel-header-row">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Catalog</h3>
          <p className="text-xs text-slate-500">Discovered events and dimensions from ingested metrics.</p>
        </div>
        <button type="button" onClick={onRefresh} className="btn-secondary">{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      <div className="space-y-4 p-4">
        {error ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{error}</div> : null}
        <label className="block">
          <span className="field-label">Search Catalog</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} className="mini-input" placeholder="Event or dimension" />
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Events</h4>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{events.length}</span>
          </div>
          <div className="max-h-48 space-y-1 overflow-auto rounded-lg border border-slate-100 bg-slate-50 p-1">
            {visibleEvents.length ? visibleEvents.map((eventName) => (
              <button
                key={eventName}
                type="button"
                onClick={() => onSelectEvent(eventName)}
                className={`w-full rounded-md px-3 py-2 text-left text-xs font-semibold transition ${selectedEvent === eventName ? 'bg-slate-950 text-white' : 'text-slate-700 hover:bg-white hover:text-slate-950'}`}
              >
                {eventName}
              </button>
            )) : (
              <p className="px-3 py-6 text-center text-xs text-slate-500">{events.length ? 'No events match this search.' : 'No events discovered yet. Ingest events first or type an event manually.'}</p>
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Dimensions</h4>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{dimensions.length}</span>
          </div>
          <div className="max-h-72 space-y-2 overflow-auto">
            {visibleDimensions.length ? visibleDimensions.map((dimension) => (
              <div key={dimension} className="rounded-lg border border-slate-200 bg-white p-2">
                <button type="button" onClick={() => onAddGroup(dimension)} className="block w-full truncate text-left text-xs font-semibold text-slate-800 hover:text-primary" title={`Add ${dimension} as group`}>
                  {dimension}
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => onAddGroup(dimension)} className="btn-label">Group</button>
                  <button type="button" onClick={() => onAddMetric('count', dimension)} className="btn-label">Count</button>
                  {looksNumericDimension(dimension) ? (
                    <>
                      <button type="button" onClick={() => onAddMetric('avg', dimension)} className="btn-label-secondary">Avg</button>
                      <button type="button" onClick={() => onAddMetric('sum', dimension)} className="btn-label-secondary">Sum</button>
                      <button type="button" onClick={() => onAddMetric('max', dimension)} className="btn-label-secondary">Max</button>
                    </>
                  ) : null}
                </div>
              </div>
            )) : (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-500">{dimensions.length ? 'No dimensions match this search.' : 'Select an event to see its dimensions.'}</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function MetricsIngestMode({ value, event, onUseEvent, catalogEvents, onChange, onCopy, onRun }) {
  function useSelectedEventSample() {
    const events = sampleEvents.map((item) => ({ ...item, event: event || item.event }));
    onChange(pretty(events));
  }

  return (
    <section className="panel">
      <div className="panel-header-row">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Events</h3>
          <p className="text-xs text-slate-500">JSON array sent as payload.events to metrics_ingest.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={useSelectedEventSample} className="btn-secondary">Use Selected Event</button>
          <button type="button" onClick={onCopy} className="btn-secondary">Copy Request</button>
          <button onClick={onRun} className="btn-primary">Ingest Events</button>
        </div>
      </div>
      {catalogEvents.length ? (
        <div className="flex flex-wrap gap-2 border-b border-slate-100 px-4 py-3">
          {catalogEvents.slice(0, 12).map((eventName) => (
            <button key={eventName} type="button" onClick={() => onUseEvent(eventName)} className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${event === eventName ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              {eventName}
            </button>
          ))}
        </div>
      ) : null}
      <div className="panel-body"><JsonEditor value={value} onChange={onChange} minHeight="420px" /></div>
    </section>
  );
}

function MetricsRawMode({ value, onChange, onCopy, onFormat, onRun }) {
  return (
    <section className="panel">
      <div className="panel-header-row">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Raw Request</h3>
          <p className="text-xs text-slate-500">Send a hand-written metrics gateway request scoped to this DB.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onFormat} className="btn-secondary">Format</button>
          <button type="button" onClick={onCopy} className="btn-secondary">Copy Request</button>
          <button onClick={onRun} className="btn-primary">Send Raw</button>
        </div>
      </div>
      <div className="panel-body"><JsonEditor value={value} onChange={onChange} minHeight="420px" /></div>
    </section>
  );
}

function catalogValues(data) {
  const items = data?.data?.items || data?.items || [];
  const values = items.map((item) => String(item.value || '').trim()).filter(Boolean);
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function addCsvValue(current, value) {
  const existing = String(current || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!existing.includes(value)) existing.push(value);
  return existing.join(', ');
}

function removeCsvValue(current, value) {
  return csvValues(current).filter((item) => item !== value).join(', ');
}

function csvValues(current) {
  return String(current || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMetrics(metricsText) {
  const [parsed, error] = tryParseJson(metricsText, []);
  return !error && Array.isArray(parsed) ? parsed : [];
}

function addMetricToText(metricsText, op, field) {
  const metrics = parseMetrics(metricsText);
  const cleanField = field || '*';
  const alias = metricAlias(op, cleanField);
  if (metrics.some((metric) => metric.alias === alias)) return pretty(metrics);
  const next = {
    op,
    field: cleanField,
    alias,
    label: titleFromAlias(alias)
  };
  return pretty([...metrics, next]);
}

function metricAlias(op, field) {
  if (field === '*') return op === 'count' ? 'events' : op;
  const fieldAlias = aliasFromField(field.replace(/^dimensions\./, ''));
  return `${fieldAlias}_${op}`.replace(/_+/g, '_');
}

function looksNumericDimension(path) {
  return /(amount|avg|bytes|count|duration|latency|max|min|ms|score|size|sum|time|tokens|total|value)$/i.test(String(path || '').split('.').pop());
}

function filterRowsFromJson(filterText) {
  const [parsed, error] = tryParseJson(filterText, {});
  if (error || !parsed || Array.isArray(parsed) || typeof parsed !== 'object') return [];
  return Object.entries(parsed).map(([field, condition]) => {
    if (condition && !Array.isArray(condition) && typeof condition === 'object') {
      const [[op, rawValue]] = Object.entries(condition);
      return { field, op: op || '$eq', value: stringifyFilterValue(rawValue) };
    }
    return { field, op: '$eq', value: stringifyFilterValue(condition) };
  });
}

function filterJsonFromRows(rows) {
  return rows.reduce((acc, row) => {
    const field = String(row.field || '').trim();
    if (!field) return acc;
    const value = parseFilterValue(row.value);
    acc[field] = row.op === '$eq' ? value : { [row.op]: value };
    return acc;
  }, {});
}

function parseFilterValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const [parsed, error] = tryParseJson(raw);
  return error ? raw : parsed;
}

function stringifyFilterValue(value) {
  return typeof value === 'string' ? value : pretty(value);
}
