# Kokoadb

**Kokoadb** is a fast and lightweight data platform built in Rust on LibSQL/SQLite. It runs locally, in Docker, or with S3-backed storage, and it's exposed as a single RPC-style HTTP endpoint: JSON in, JSON out.

One consistent JSON API, seven capabilities:

| | |
|---|---|
| **Data** | Schemaless JSON in namespaces. Filters, joins, aggregation, projection, TTL, soft delete, and transactions. |
| **Identity** | User records, provider links, statuses, and token hashes. Your app authenticates; Kokoadb stores the state. |
| **Files** | Metadata registry for objects stored elsewhere: ownership, location, hashes, expiry, deletion state. |
| **Search** | Full-text search (FTS5) over live documents, with background indexing. |
| **SQL** | Parameterized SQL against your own tables in the same database, plus table and schema discovery. Uses SQLite |
| **Metrics** | Event ingest with bucketed, grouped aggregation over rolling and calendar ranges. |
| **Admin** | Backups, snapshots, S3 sync, JSONL import/export, background jobs, and a built-in Admin UI. |

📖 **[Full documentation](DOCUMENTATION.md)** · also served at `/_/kdb/doc` on any running instance.

## Contents

- [Install and run](#install-and-run)
- [HTTP endpoints](#http-endpoints)
- [Request envelope](#request-envelope)
- [Operations](#operations)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Scope and boundaries](#scope-and-boundaries)

## Install and run

```bash
docker run -d \
  --name kokoadb \
  -p 6543:6543 \
  -e KOKOADB_ACCESS_KEY=dev-secret \
  -v kokoadb-data:/data \
  kokoadb
```

Everything durable — database files, local backups, local exports — lives under `/data`.

Verify the service:

```bash
curl http://localhost:6543/_/kdb/ping
```

Write a document:

```bash
curl -X POST http://localhost:6543/_/kdb/gateway \
  -H 'content-type: application/json' \
  -H 'x-access-key: dev-secret' \
  -d '{"db":"myapp/main","operation":"insert","namespace":"users","payload":{"data":{"name":"Ada"}}}'
```

The database and namespace are created by the insert. Only `create_db`, `insert`, and `import_jsonl` can create a database; every other operation fails on a missing one.

The Admin UI is at `http://localhost:6543/_/kdb/admin/`. When authentication is enabled, the browser prompts for HTTP Basic credentials: username `kongodb`, password `KOKOADB_ACCESS_KEY`.

See [Quickstart](DOCUMENTATION.md#quickstart) for TypeScript and Python client wrappers.

## HTTP endpoints

All routes sit under `KOKOADB_BASE_PATH` (default `/_/kdb`).

| Method | Route | Purpose | Auth |
|---|---|---|---|
| `POST` | `/gateway` | All operations. | `X-Access-Key` |
| `GET` | `/ping` | Service health and version. | Open |
| `GET` | `/meta/operations` | Machine-readable operation catalog. | `X-Access-Key` |
| `GET` | `/doc` | Rendered Markdown documentation. | Basic |
| `GET` | `/admin/` | Admin UI, when enabled. | Basic |

`KOKOADB_AUTH_MODE=access_key` requires a non-empty `KOKOADB_ACCESS_KEY`. `KOKOADB_AUTH_MODE=none` disables authentication for trusted local development. HTTP Basic credentials are only transport-safe behind TLS.

## Request envelope

Every operation is a `POST` to `/gateway` using the same four fields:

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": { "filter": {"status": "active"} }
}
```

| Field | Description |
|---|---|
| `db` | Database path, such as `myapp/main`. Required except for global operations. |
| `operation` | Operation name. |
| `namespace` | Document grouping. Required, optional, or rejected depending on the operation. |
| `payload` | Filters, data, and operation options. |

Namespace selectors: `"users"` reads one namespace, `["users","admins"]` reads several, `"*"` reads all. Writes always target exactly one concrete namespace. An optional shorthand folds the selector into the operation name: `"query::users"`, `"query::*"`, `"query::users,admins"`.

Responses:

```jsonc
{ "status": "success", "data": {}, "committed": true, "is_async_ack": false }
{ "status": "partial", "data": { "succeeded": 1, "failed": 1, "results": [] } }  // batch operations only
{ "status": "error",   "error": "reason" }
```

Full rules for namespace policy, validation, errors, pagination, and caching are in [Request and response contract](DOCUMENTATION.md#request-and-response-contract).

## Operations

### Documents

| Operation | Description |
|---|---|
| `insert` | Create one or many documents. Creates the database and namespace when absent. |
| `update` | Patch by explicit `_id`, by id array, or by filter. Never inserts. |
| `upsert` | Update filter matches, or insert one document when none exist. |
| `query` | General read: filters, sort, pagination, projection, FTS, lookups, compute, user attachments. |
| `multi_query` | Several independent read-only queries in one request. |
| `count` | Number of matching documents only. |
| `aggregate` | Set-level counts, sums, averages, extrema, and distinct values. |
| `delete` | Soft-delete into the archive, or `purge: true` to remove permanently. |
| `set_ttl` | Schedule or clear document expiration. |
| `transaction` | Insert, update, upsert, and delete children in one SQL transaction. |

Operators: [filter](DOCUMENTATION.md#filter-operators) (`$eq`, `$in`, `$elemMatch`, `$regex`, `[]` wildcards), [compute](DOCUMENTATION.md#compute-operators) (`$sum`, `$distinct`, `$join`), [generator](DOCUMENTATION.md#generator-operators) (`@now`, `@uuidv7`, `@hash`), [mutation](DOCUMENTATION.md#mutation-operators) (`$inc`, `$push`, `$addset`, `$rename`), [lookup match](DOCUMENTATION.md#lookup-operators) (`$eq`, `$in`, `$contains`, `$overlap`).

### Document lifecycle

Named, durable, one-time conditional mutations evaluated at a scheduled time.

| Operation | Description |
|---|---|
| `schedule_transition` | Create or replace a named scheduled conditional mutation. |
| `get_transition`, `list_transitions` | Inspect and paginate transition history. |
| `cancel_transition` | Cancel one pending transition, retaining it as history. |
| `retry_transition` | Reopen a failed transition. Failures do not retry automatically. |

### Import, export, and jobs

| Operation | Description |
|---|---|
| `import_jsonl` | Streaming, resumable JSONL ingestion from local storage or S3. |
| `export_jsonl` | Filtered, projection-aware JSONL export. |
| `create_import_upload_url` | Presigned S3 `PUT` for a browser-side import upload. |
| `create_download_url` | Presigned S3 `GET` for a completed export, backup, or snapshot. |
| `get_job`, `list_jobs`, `continue_job`, `abort_job` | Shared background job control. |

### Identity

Stores login-related metadata. Kokoadb does not authenticate users; see [Scope and boundaries](#scope-and-boundaries).

| Operation | Description |
|---|---|
| `user_create`, `user_get`, `user_query`, `user_update`, `user_delete` | User records and search. `user_get` can explicitly include password-verification credentials for trusted backend use. |
| `user_get_details` | One user with providers, login methods, and recent lifecycle events. |
| `user_update_password` | Atomically replace an application-generated password hash. |
| `user_update_status` | Change status immediately or schedule a future transition. |
| `user_create_token`, `user_get_token`, `user_consume_token`, `user_revoke_token` | Token hashes with atomic single-use consumption. |
| `user_link_provider`, `user_unlink_provider` | External identity provider links. |

### Files

Metadata registry for objects the application stores elsewhere.

| Operation | Description |
|---|---|
| `file_create`, `file_get`, `file_query`, `file_update`, `file_delete` | File metadata records and search. Soft-deleted records are excluded from gets, queries, and counts; purge removes metadata permanently. |

### Metrics

| Operation | Description |
|---|---|
| `metrics_ingest` | Append application metric events. |
| `metrics_query` | Bucketed and grouped aggregation over rolling or calendar ranges. |
| `metrics_catalog` | Discover registered event names and dimension paths. |

### SQL and search

| Operation | Description |
|---|---|
| `sql_execute` | One parameterized read, write, or limited DDL statement. |
| `sql_list_tables`, `sql_get_table_schema` | Table discovery and safe schema inspection. |
| `create_index`, `drop_index`, `list_indexes` | Manual JSON expression indexes. |
| `enable_fts_index`, `reindex_fts`, `drop_fts_index` | Full-text search lifecycle. |

### Namespaces

| Operation | Description |
|---|---|
| `list_namespaces`, `get_namespace_stats`, `get_data_count` | Inventory and statistics. |
| `recompute_stats` | Queue a full statistics rebuild. |
| `drop_namespace` | Archive or permanently purge all documents in a namespace. |
| `restore_archive`, `purge_archive` | Restore or permanently delete archived documents. |
| `change_namespace`, `rename_namespace` | Move documents, or rename across live and archive data. |

### Database lifecycle

| Operation | Description |
|---|---|
| `create_db`, `db_exists`, `clone_db` | Create, check existence, copy. |
| `delete_db` | Create an archive-tagged backup, then permanently remove the live local/S3 database. |
| `create_backup`, `restore_backup`, `list_backups`, `tag_backup` | Compressed backups with a searchable catalog. |
| `load_db`, `offload_db`, `sync_db`, `get_sync_status`, `verify_db` | S3 hydration and synchronization. |
| `create_snapshot`, `list_snapshots`, `restore_snapshot`, `compact_wal` | Versioned snapshots and WAL maintenance. |
| `vacuum_db`, `reap_db` | Compaction; immediate TTL, archive, and lifecycle processing. |

### System

| Operation | Description |
|---|---|
| `list_commands`, `list_dbs`, `list_all_dbs` | Instance inventory. Global; no `db` required. |
| `system_get_inventory`, `system_refresh_inventory`, `purge_system_db`, `system_get_db_status` | Cross-database system catalog, including local catalog purge/rebuild. |
| `system_snapshot_db_stats`, `system_query_db_stats`, `system_list_db_events` | Durable statistics and lifecycle history. |
| `get_system_stats`, `system_memory`, `cleanup_temp_artifacts` | Runtime statistics, memory, temporary-file cleanup. |
| `get_system_config`, `get_db_stats`, `snapshot_db_stats`, `query_db_stats` | Per-database configuration and counters. |

Required inputs and full option tables: [Operation index](DOCUMENTATION.md#operation-index).

## Configuration

`kokoadb.env` is the canonical environment template. `KOKOADB_*` is the supported configuration prefix.

```env
KOKOADB_PORT=6543
KOKOADB_BASE_PATH=/_/kdb
KOKOADB_AUTH_MODE=access_key          # or `none` for trusted local development
KOKOADB_ACCESS_KEY=a-long-random-secret

KOKOADB_STORAGE_MODE=local            # or `s3`
KOKOADB_DATA_DIR=/data

KOKOADB_RUNTIME_PROFILE=balanced      # memory | balanced | throughput
KOKOADB_WRITE_MODE=committed          # direct | committed | accepted
KOKOADB_QUERY_DEFAULT_LIMIT=50
KOKOADB_OPERATION_TIMEOUT_MS=30000
```

Every setting: [Configuration reference](DOCUMENTATION.md#configuration).

## Deployment

| Target | Storage mode | Notes |
|---|---|---|
| Local or embedded | `local` | Files under `KOKOADB_DATA_DIR`. |
| Docker or VM | `local` | Named volume or host mount at `/data`. Bind to `127.0.0.1` behind a TLS proxy. |
| Cloud Run or serverless | `s3` | Container-local paths are instance cache only. |

```bash
docker compose up --build -d
```

Compose builds the local Dockerfile, serves the Admin UI, loads `kokoadb.env`, and mounts a named `kokoadb-data` volume at `/data`.

See [Deployment](DOCUMENTATION.md#deployment) for the production checklist and Cloud Run configuration.

## Scope and boundaries

Kokoadb deliberately stops short in four places.

- **Authentication.** The Identity store holds users, providers, statuses, and token hashes. It never verifies a password, validates an OAuth token, issues a session, or enforces permissions. The application does that and calls Kokoadb to record the result.
- **File bytes.** The File catalog tracks metadata about objects stored elsewhere. It never uploads, downloads, moves, or deletes actual files.
- **Concurrent writers.** Per-database write coordinators serialize mutations, and writer leases apply in both S3 topologies. S3 mode provides durability, snapshots, and recovery rather than multi-master writes.
- **Horizontal scale.** Kokoadb runs on one node and does not shard across machines.

## Development

```bash
./scripts/run-local.sh          # Run local server
./scripts/smoke.sh              # full smoke test
```

## Documentation

- [DOCUMENTATION.md](DOCUMENTATION.md) — complete reference
- [Core concepts](DOCUMENTATION.md#core-concepts) — databases, namespaces, write acknowledgments, the archive
- [Cookbook](DOCUMENTATION.md#cookbook) — copy/paste requests for every operation

## License

Kokoadb is licensed under the **MIT License**.

Copyright (c) 2026 Singlebase. All rights reserved.
