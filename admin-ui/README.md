# Kokoa Admin UI

The Rust server serves the production build as an SPA at
`${KOKOADB_BASE_PATH}/admin/` when `KOKOADB_ADMIN_UI_ENABLED=true`. Vite uses
relative asset URLs, so the build works under any configured base path.
The browser prompt uses `kokoadb` as the username and `KOKOADB_ACCESS_KEY` as
the password. `KOKOADB_AUTH_MODE=none` disables authentication for trusted local development.

Standalone React admin for Kokoadb. It lives outside the Rust build and can be developed or deployed independently.

## Stack

- React
- Vite
- Tailwind CSS compiled through Vite

## Run

```bash
cd admin-ui
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:5174
```

## Build

```bash
npm run build
npm run preview
```

## Interface

The UI is organized as a three-level database workspace:

- The Kokoa home only shows `Home` and `Connections`; it does not open or query a database.
- Selecting a saved connection verifies it with Ping, then opens that host's cached database inventory.
- Selecting a database opens its overview with quick stats and links to `Data`, `Identity`, `Files`, `Metrics`, `Search`, and `SQL`.
- Database-scoped navigation also exposes raw `Query`, detailed `Stats`, and `Database Admin` tools.
- Contextual back actions move from a database to its host inventory, then from the host back to Kokoa home.
- Files uses a browse-first inventory with dedicated Add File, Update, and Query workspaces plus a focused file-detail modal.
- Request controls are collapsible and keep the response visible below.
- Response viewer supports table and raw JSON modes.
- Admin includes global tools and the System Catalog view for durable DB inventory, status, stats snapshots, and catalog events.
- Database Admin can upload `.jsonl` and `.jsonl.zst` files directly to S3 with a presigned URL, then enqueue the existing resumable import job.
- Database Admin can download completed S3 exports, backups, and immutable snapshots through short-lived signed links.
- Metrics shows instance-local in-memory runtime counters, memory, queues, and request windows.
- Connection settings stored in browser localStorage.

## Source Structure

```text
src/
  App.jsx
  main.jsx
  components/
    DbCrudConsole.jsx
    GlobalAdminPanel.jsx
    SystemCatalogPanel.jsx
    SystemMetricsPanel.jsx
    MetricsEventsConsole.jsx
    SettingsPanel.jsx
    ResponsePanel.jsx
    JsonEditor.jsx
    Layout.jsx
    Sidebar.jsx
    Toast.jsx
  context/
    AdminContext.jsx
  lib/
    api.js
    format.js
    presets.js
    results.js
```

## Features

- Save server URL, base path, and access key in local storage.
- Ping Kokoadb and open `/doc`.
- List DBs with size/local/S3 flags and select a DB before entering DB View.
- List namespaces with live/archive count and size stats.
- Run CRUD gateway operations from editable JSON presets.
- Render dynamic result tables for arbitrary response shapes.
- Toggle full raw JSON response view.
- Build, preview, and run `metrics_query` requests for metric events aggregation.
- Inspect the internal system catalog through `system_get_inventory`, `system_refresh_inventory`, `system_get_db_status`, `system_snapshot_db_stats`, `system_query_db_stats`, and `system_list_db_events`.

## Notes

- This app calls Kokoadb directly from the browser, so Kokoadb must allow the UI origin:

```env
KOKOADB_CORS_ALLOWED_ORIGINS=http://127.0.0.1:5174,http://localhost:5174
```

- Do not expose this admin UI publicly without network-level protection and a strong `KOKOADB_ACCESS_KEY`.
- Tailwind is compiled by Vite; shared UI classes live in `src/styles.css`.
