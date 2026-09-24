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

```bash
curl -X POST http://localhost:6543/_/kdb/gateway \
  -H 'content-type: application/json' \
  -H 'x-access-key: your-key' \
  -d '{"db":"myapp/main","operation":"insert","namespace":"users","payload":{"data":{"name":"Ada"}}}'
```

That single request creates the database, creates the namespace, and stores the document.

---

## Table of contents

**Getting started**
- [Quickstart](#quickstart)
- [Core concepts](#core-concepts)
- [Scope and boundaries](#scope-and-boundaries)

**The API**
- [Endpoints and authentication](#endpoints-and-authentication)
- [Request and response contract](#request-and-response-contract)
- [Errors](#errors)
- [Pagination](#pagination)
- [Read caching](#read-caching)
- [Payload property reference](#payload-property-reference)
- [Operation index](#operation-index)

**Datastore**
- [Document operations](#document-operations) — `insert`, `update`, `upsert`, `delete`, `count`, `query`, `multi_query`, `aggregate`, `set_ttl`, `transaction`
- [Filter operators](#filter-operators)
- [Sorting](#sorting)
- [Projection](#projection)
- [Lookup operators (joins)](#lookup-operators)
- [Compute operators](#compute-operators)
- [Generator operators](#generator-operators)
- [Mutation operators](#mutation-operators)
- [Positional array updates](#positional-array-updates)
- [Document lifecycle transitions](#document-lifecycle-transitions)

**Product stores**
- [Identity store](#identity-store)
- [File catalog](#file-catalog)
- [Metrics events](#metrics-events)
- [Search & Indexes](#full-text-search)
- [SQL operations](#sql-operations)

**Operations and administration**
- [Namespace lifecycle](#namespace-lifecycle)
- [Database operations](#database-operations)

- [System and monitoring](#system-and-monitoring)


**Import, export, jobs**
- [`import_jsonl`](#import_jsonl)
- [Browser upload to S3](#browser-upload-to-s3)
- [`export_jsonl`](#export_jsonl)
- [Presigned downloads](#presigned-downloads)
- [Job control](#job-control)


**Running it**
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Cookbook](#cookbook)
- [Behavior notes and limits](#behavior-notes-and-limits)

---

## Quickstart

### 1. Run the server

```bash
docker run -d \
  --name kokoadb \
  -p 6543:6543 \
  -e KOKOADB_ACCESS_KEY=dev-secret \
  -v kokoadb-data:/data \
  kokoadb
```

Docker creates the named volume automatically. Everything durable — database files, local backups, local exports — lives under `/data`.

Verify:

```bash
curl http://localhost:6543/_/kdb/ping
```

`/ping` is the only route that never requires authentication.

### 2. Write

```bash
curl -X POST http://localhost:6543/_/kdb/gateway \
  -H 'content-type: application/json' \
  -H 'x-access-key: dev-secret' \
  -d '{
    "db": "myapp/main",
    "operation": "insert",
    "namespace": "users",
    "payload": {
      "data": {"email": "ada@example.com", "name": "Ada", "status": "active"}
    }
  }'
```

```json
{
  "status": "success",
  "data": {
    "count": 1,
    "inserted_count": 1,
    "skipped_count": 0,
    "items": [{
      "_id": "7835cb6159234c49955326a93adade8f",
      "email": "ada@example.com",
      "name": "Ada",
      "status": "active",
      "_created_at": "2026-08-07T12:00:00.000Z",
      "_modified_at": "2026-08-07T12:00:00.000Z"
    }]
  },
  "committed": true,
  "is_async_ack": false
}
```

You never created the database or the namespace. `insert` creates both. Only `create_db`, `insert`, and `import_jsonl` can create a database — every other operation fails on a missing one, which protects you from typo-created ghost databases.

### 3. Read

```bash
curl -X POST http://localhost:6543/_/kdb/gateway \
  -H 'content-type: application/json' \
  -H 'x-access-key: dev-secret' \
  -d '{
    "db": "myapp/main",
    "operation": "query",
    "namespace": "users",
    "payload": {
      "filter": {"status": "active"},
      "sort": "_created_at desc",
      "limit": 10
    }
  }'
```

`query` is the general read operation. There is no separate `get` or `search` endpoint: use an `_id` filter for direct retrieval and `payload.search` for full-text search.

### 4. Wire it into your app

**JavaScript / TypeScript**

```ts
const BASE = process.env.KOKOADB_URL ?? "http://localhost:6543";
const KEY = process.env.KOKOADB_ACCESS_KEY!;

type KokoaEnvelope<T> =
  | { status: "success" | "partial"; data: T; committed?: boolean; is_async_ack?: boolean }
  | { status: "error"; error: string };

export async function kokoa<T = any>(body: {
  db?: string;
  operation: string;
  namespace?: string | string[];
  payload?: Record<string, unknown>;
}): Promise<T> {
  const res = await fetch(`${BASE}/_/kdb/gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-key": KEY },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as KokoaEnvelope<T>;
  if (json.status === "error") throw new Error(json.error);
  return json.data;
}

const { items } = await kokoa<{ items: any[] }>({
  db: "myapp/main",
  operation: "query",
  namespace: "users",
  payload: { filter: { status: "active" }, limit: 10 },
});
```

**Python**

```python
import os, requests

BASE = os.environ.get("KOKOADB_URL", "http://localhost:6543")
KEY = os.environ["KOKOADB_ACCESS_KEY"]

class KokoaError(RuntimeError):
    pass

def kokoa(operation, db=None, namespace=None, payload=None):
    body = {"operation": operation, "payload": payload or {}}
    if db:
        body["db"] = db
    if namespace is not None:
        body["namespace"] = namespace

    out = requests.post(
        f"{BASE}/_/kdb/gateway",
        json=body,
        headers={"x-access-key": KEY},
        timeout=35,
    ).json()

    if out.get("status") == "error":
        raise KokoaError(out.get("error", "unknown error"))
    return out["data"]

data = kokoa("query", db="myapp/main", namespace="users",
             payload={"filter": {"status": "active"}, "limit": 10})
```

Set your client timeout slightly above `KOKOADB_OPERATION_TIMEOUT_MS` (default `30000`) so the server's timeout wins and you receive a real error envelope instead of a socket hang-up.

### 5. Open the Admin UI

Visit `http://localhost:6543/_/kdb/admin/`. When authentication is enabled, the browser prompts for HTTP Basic credentials:

- **Username:** `kongodb`
- **Password:** your `KOKOADB_ACCESS_KEY`

> **Use HTTPS outside localhost.** HTTP Basic credentials are only transport-safe behind TLS. Put a reverse proxy in front before exposing `/admin/` or `/doc` publicly.

---

## Core concepts

Read this once and the rest of the API stops being surprising.

### One endpoint, one envelope

There are no REST resources. Every operation is a `POST` to `/gateway` with the same four fields:

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": { "filter": {"status": "active"} }
}
```

| Field | Purpose |
|---|---|
| `db` | Selects the database file. Required except for global operations. |
| `operation` | Names what to do. |
| `namespace` | Groups documents inside the database. Required, optional, or rejected depending on the operation. |
| `payload` | Everything else. |

One client function, one auth header, one error shape.

### Databases

`db` is a **path**, not a name: `myapp/main`, `tenant_42/analytics`, `test/db02.main`. Kokoadb maps it to a SQLite file under `KOKOADB_DATA_DIR`, or to an S3 prefix in `s3` mode.

- **Databases are cheap.** A database per tenant is a normal design. `KOKOADB_MAX_ACTIVE_DBS` (default `100`) caps how many stay *open*; beyond that, least-recently-used connections are evicted and reopened on demand.
- **Nothing crosses a database.** Lookups, transactions, and `multi_query` all operate within the single `db` named in the outer request. There are no cross-file joins.
- **Only three operations create one:** `create_db`, `insert`, `import_jsonl`.
- **Some operations are global** and omit `db` entirely — `list_commands`, `list_dbs`, `list_all_dbs`, `get_system_stats`, `system_get_inventory`, and friends.

### Namespaces

A namespace is a **label on a document, not a separate table**. `users`, `orders`, and `sessions` all live in the same document table, distinguished by a namespace column.

That design has direct consequences:

- **`_id` is globally unique within a database**, not per namespace. This is why ID-targeted `update` and `delete` may omit `namespace`.
- **Reads can span namespaces.** `namespace: ["users","admins"]` reads several; `namespace: "*"` reads all. Both automatically add `_namespace` to returned items.
- **Writes cannot.** `insert` and upsert-insert paths require exactly one concrete namespace — no arrays, no `"*"`.
- **Renaming is cheap.** `rename_namespace` and `change_namespace` update a column; they do not rewrite a table.

When you supply a namespace on an ID-targeted operation it becomes a **strict ownership check**: the document must be in that namespace or it is skipped.

### Documents and reserved fields

A document is any JSON object. Kokoadb adds a small set of reserved fields:

| Field | Meaning | Storage |
|---|---|---|
| `_id` | Unique id. Auto-generated as a dashless UUIDv4 when absent. | Column |
| `_created_at` / `_modified_at` | UTC RFC3339 system timestamps. | Columns |
| `_namespace` | Namespace label. Hidden unless requested or implied. | Column |
| `_user_id` | Optional Identity user reference. | Column, **not** inside `data` |
| `_metadata` | Hidden app metadata. Returned only with `include_metadata: true`. | Column, **not** inside `data` |
| `_expires_at` / `_expiry_behavior` | TTL state. | Columns |
| `_txn_id` | Assigned to one soft-delete operation; the handle for restore/purge. | Archive column |
| `_search_score` | BM25 relevance. Exists only in FTS query mode. | Computed |

> **`_user_id` and `_metadata` are columns, not document fields.** Putting either inside `payload.data` **fails the request**. Pass them as siblings of `data` instead. This trips up nearly everyone once.

Everything else in the document is yours. `_key` has no special meaning — it is stored, filtered, and returned like ordinary data.

### Write acknowledgment: committed vs accepted

Every database has a **write coordinator** that serializes mutations. Choose per request how long to wait:

| `payload.commit` | Behavior | Response fields |
|---|---|---|
| `true` | Wait for the coordinator to persist the mutation. | `committed: true`, `is_async_ack: false` |
| `false` | Queue it and acknowledge immediately. | `committed: false`, `is_async_ack: true`, `ack_mode: "accepted"`, `ack_status: "queued"` |

The default comes from `KOKOADB_WRITE_MODE` (`committed`, `accepted`, or `direct`). If the queue is unavailable, an accepted write falls back to committed execution rather than failing.

What comes back differs by shape:

- **Accepted `insert` and explicit-ID `update`** return the prepared documents immediately — Kokoadb already knows exactly what it will write.
- **Accepted filter-based mutations** return only an acknowledgment, because the write worker resolves targets later.

**Reads see pending writes.** An exact `_id` / `_id.$in` query overlays queued accepted writes by default, so read-after-write behaves as expected. Set `force_db: true` when you need durable-only SQLite state.

### Soft delete and the archive

`delete` is recoverable by default. Kokoadb copies each matched document into `__kdb_archive` — preserving original timestamps and namespace — assigns one `_txn_id` to the whole operation, then removes it from the live table.

```
live table ──delete──▶ __kdb_archive ──restore_archive──▶ live table
                             │
                             └──purge_archive──▶ gone
```

- Keep the returned `_txn_id`. It is the handle for `restore_archive` and `purge_archive`.
- `purge: true` skips the archive and deletes permanently.
- Reads opt in with `include_archive: true` or `archive_only: true`.
- `KOKOADB_ARCHIVE_TTL_SECS` sets automatic archive retention; empty keeps rows until you purge.

### Two clocks: TTL vs lifecycle transitions

These are separate systems and are routinely confused.

| | TTL | Lifecycle transition |
|---|---|---|
| **Triggers on** | `_expires_at` | `execute_at` |
| **Effect** | Archives or deletes the whole document | Evaluates a `when` condition, then patches fields |
| **Conditional?** | No | Yes — skips when `when` no longer matches |
| **Created by** | `ttl_seconds` on a write, or `set_ttl` | `payload.lifecycle`, or `schedule_transition` |

A transition may also set `ttl_seconds`, handing later expiry back to TTL. Both are driven by the background reaper; `reap_db` runs a pass immediately.

### Jobs

Long work never blocks the gateway. `import_jsonl`, `export_jsonl`, `create_backup`, `reindex_fts`, `drop_fts_index`, `vacuum_db`, and `recompute_stats` return a `job_id` immediately. Background workers claim jobs through `__kdb_jobs`, persist progress after each batch, and can hand a resumable failed job to another worker at its recorded offset. Track everything with `get_job` / `list_jobs` / `continue_job` / `abort_job`.

### Reserved names

Kokoadb owns two prefixes inside every database:

- `__kdb_*` — internal tables (`__kdb_archive`, `__kdb_jobs`, `__kdb_identity_users`, `__kdb_files`, `__kdb_metrics_catalog`, …)
- `sqlite_*` — SQLite internals

`sql_execute` rejects any statement naming a table or index with these prefixes, and `sql_list_tables` hides them. You get direct SQL without being able to corrupt platform state.

---

## Scope and boundaries

Kokoadb deliberately stops short in four places. Knowing where saves time later.

- **Authentication.** The Identity store holds users, providers, statuses, and token hashes. It never verifies a password, validates an OAuth token, issues a session, or enforces permissions. The application does all of that and calls Kokoadb to record the result.
- **File bytes.** The File catalog tracks metadata about objects stored elsewhere. It never uploads, downloads, moves, or deletes actual files.
- **Concurrent writers.** Per-database write coordinators serialize mutations, and writer leases apply in both S3 topologies. S3 mode provides durability, snapshots, and recovery rather than multi-master writes.
- **Horizontal scale.** Kokoadb runs on one node. It handles a large single-machine workload well and does not shard across machines.

---

## Endpoints and authentication

All routes sit under `KOKOADB_BASE_PATH` (default `/_/kdb`).

| Method | Route | Purpose | Auth |
|---|---|---|---|
| `POST` | `${BASE}/gateway` | Every operation. | Access key |
| `GET` | `${BASE}/ping` | Service health and version. | **Open** |
| `GET` | `${BASE}/meta/operations` | Machine-readable operation catalog. | Access key |
| `GET` | `${BASE}/doc` | Rendered Markdown documentation. | Browser gate |
| `GET` | `${BASE}/admin/` | Built-in Admin UI SPA, when enabled. | Browser gate |

### Authentication modes

| `KOKOADB_AUTH_MODE` | Behavior |
|---|---|
| `access_key` (default) | Requires a non-empty `KOKOADB_ACCESS_KEY`. Startup fails without one. |
| `none` | Explicitly disables authentication for trusted local development. Any configured key is ignored. |

An invalid value fails startup rather than falling back silently.

### Credentials

| Client | Mechanism |
|---|---|
| API clients | `X-Access-Key: <key>` header |
| Browser (`/doc`, `/admin/`) | HTTP Basic — username `kongodb`, password = `KOKOADB_ACCESS_KEY` |

Production:

```env
KOKOADB_AUTH_MODE=access_key
KOKOADB_ACCESS_KEY=a-long-random-secret
```

Trusted local development:

```env
KOKOADB_AUTH_MODE=none
KOKOADB_ACCESS_KEY=
```

> HTTP Basic credentials are only transport-safe when TLS protects the connection. Terminate HTTPS at a reverse proxy before exposing browser routes off localhost.

---

## Request and response contract

### The envelope

```json
{
  "db": "myapp/something/main",
  "operation": "query",
  "namespace": "users",
  "payload": {
    "filter": {"status": "active"}
  }
}
```

Fields described as **top-level** belong beside `db` and `operation`. Everything else belongs inside `payload`.

### Normalization and validation rules

- `db` is required for database-scoped operations. Operations explicitly marked global (instance inventory, system runtime statistics) may omit it.
- `namespace` is the **only** public namespace selector. It accepts a string for one namespace or a non-empty string array for several.
- Database creation is permitted only by `create_db`, `insert`, and `import_jsonl`.

### Namespace policy by operation

| Operation shape | Namespace rule |
|---|---|
| `insert`, upsert-insert path | **Required**, exactly one concrete string. `"*"` and arrays are rejected. |
| `query` | **Required** — one string, an array, or `"*"`. |
| ID-targeted `update`, `delete` | Optional. When supplied it is a strict ownership check. |
| Filter/wide destructive ops (`update`, `delete`, `set_ttl`, namespace-level ops) | Required unless the operation supports an explicit `scope: "all"`. |
| Global ID reads | `query` with `namespace: "*"` plus an explicit `_id` or `_id.$in` filter. |
| `change_namespace`, `rename_namespace` | Top-level `namespace` is **rejected**; use `from_namespace` / `to_namespace`. |

### The `*` wildcard

`namespace: "*"` maps to `payload.scope: "all"` for operations that support it. It conflicts with an explicit `payload.scope: "namespace"`.

### Shorthand alias

An optional `operation::namespace` shorthand is resolved at the request edge:

| Shorthand | Equivalent |
|---|---|
| `"query::users"` | `operation: "query"`, `namespace: "users"` |
| `"query::*"` | `operation: "query"`, `namespace: "*"` |
| `"query::users,admins,teams"` | `operation: "query"`, `namespace: ["users","admins","teams"]` |

Shorthand cannot be combined with a top-level `namespace`.

### The `_namespace` response field

Hidden by default. It appears when:

| Trigger | Scope |
|---|---|
| `KOKOADB_RESPONSE_INCLUDE_NAMESPACE=true` | Global default |
| `payload.include_namespace` (alias `include_name`) | Per request |
| `query` with `namespace: "*"` or an array | Always, automatically |

### Datetime values

- All Kokoadb system timestamps are UTC.
- Accepted input format for system timestamp fields is RFC3339/ISO-8601 with timezone: `2025-12-24T23:39:26Z`, `2025-12-24T23:39:26.873397+00:00`.
- Where `_created_at` is allowed as input and `_modified_at` is omitted, `_modified_at` is set to `_created_at`.
- Metrics query date fields (`start` and `end`) also accept plain `YYYY-MM-DD`.

### Success response

```json
{
  "status": "success",
  "data": {},
  "_txn_id": "optional",
  "message": "optional",
  "committed": true,
  "is_async_ack": false,
  "ack_mode": "optional (accepted path)",
  "ack_status": "optional (accepted path)"
}
```

Operation-specific fields are nested under `data`.

### Partial response

`status: "partial"` is returned only by batch operations (`multi_query`, `transaction`) running with `on_error: "continue"` when at least one child failed at runtime. `data.results[]` holds per-child outcomes in request order.

---

## Errors

### Envelope

```json
{
  "status": "error",
  "error": "reason"
}
```

Top-level errors carry a single human-readable string. Child results inside `multi_query` and `transaction` carry a structured object instead:

```json
{
  "alias": "orders",
  "status": "error",
  "error": {
    "code": "bad_request",
    "message": "sort direction must be ASC or DESC in string mode"
  }
}
```

### Failure classes

| Class | When it happens | Effect on a batch |
|---|---|---|
| **Structural** | Missing `operation`, unknown operation name, empty batch, duplicate `alias`, invalid `on_error`, oversized batch, malformed selectors. | Rejected **before** any execution, regardless of `on_error`. |
| **Validation** | Namespace policy violation, `_id` in a forbidden place, empty `fields: []`, mutually exclusive selectors, negative `ttl_seconds`. | Fails that request. |
| **Runtime** | Missing database, filter compilation failure, SQL error, constraint conflict. | Governed by `on_error`. |
| **Timeout** | The whole request exceeds `KOKOADB_OPERATION_TIMEOUT_MS`. | Ends the request. |

### Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Request rejected on insert | `_user_id` or `_metadata` placed inside `data` | Pass them as siblings of `data` |
| "namespace required" on a filter delete | Wide destructive op without a namespace | Supply `namespace`, or set `scope: "all"` deliberately |
| Update silently changed nothing | ID not found — `update` never inserts | Use `upsert`, or check the id |
| Namespace array rejected | Operation is an `insert` or upsert-insert path | Writes target exactly one namespace |
| FTS query rejected | `include_archive` / `archive_only` used with `search` | FTS reads live documents only |
| `_search_score` sort rejected | Not in FTS mode | Only valid when `payload.search` is present |
| `group_by` rejected in `aggregate` | Reserved, not implemented | Use `metrics_query` for grouped series |
| Documents missing after a lookup | `on_missing: "drop"` removed parents | Use `null` or `empty` |

---

## Pagination

Read operations support two interchangeable paging styles. **If `limit` or `offset` is supplied, offset mode wins.**

| Mode | Fields | Default |
|---|---|---|
| Offset | `limit`, `offset` | `limit` = `KOKOADB_QUERY_DEFAULT_LIMIT` (50), `offset` = 0 |
| Page | `page`, `per_page` | `page` = 1, `per_page` = configured limit |

Responses carry both shapes so clients can use either:

```json
{
  "status": "success",
  "data": {
    "count": 25,
    "total_items": 84,
    "items": [],
    "limit": 25,
    "offset": 25,
    "next_offset": 50,
    "prev_offset": 0,
    "pagination": {
      "total_items": 84,
      "count": 25,
      "per_page": 25,
      "page": 2,
      "total_pages": 4,
      "next_page": 3,
      "prev_page": 1
    }
  }
}
```

`count` is the number of items in this page. `total_items` is the number matched by the query. `next_offset` / `next_page` are `null` at the end of the result set.

> `export_jsonl` accepts `page`/`per_page` for shape compatibility but executes using `limit` and `offset`. Use those two for deterministic exports.

---

## Read caching

`payload.cache` applies to `count`, `query`, and `aggregate`.

| Value | Behavior |
|---|---|
| `false` or `0` | Bypass the cache. |
| `true` or `1` | Use the default TTL (`KOKOADB_CACHE_TTL_SECS`, default 60s). |
| `N > 1` | Use a per-request TTL of `N` seconds. |
| `-1` | Invalidate the relevant cache scope, then run uncached. |

Setting `KOKOADB_CACHE_TTL_SECS=0` disables the read cache entirely.

Metrics queries use a separate cache controlled by `KOKOADB_METRIC_EVENTS_CACHE_TTL_SECS` (default 30s) with the same `payload.cache` semantics. Note that `metrics_ingest` does **not** invalidate the metrics cache on every ingest.

Lookups have their own request-local cache — see [`cache_lookup`](#cache_lookup--request-local-reuse).

---

## Payload property reference

Every reusable `payload` key. Operation sections remain authoritative where a field has specialized behavior.

### Selection and scope

| Field | Type | Description |
|---|---|---|
| `id` | string | Single document id selector. |
| `ids` | string[] | Multi-id selector. |
| `filter` | object | Filter expression built from [Filter operators](#filter-operators). |
| `scope` | string | `namespace` (default) or `all`. |
| `_user_id` | string | Document-table user reference column, stored outside `data`. |
| `search` | string | FTS text for `query` (alias `q`); switches the query to live-document FTS5. |

### Write payloads

| Field | Type | Description |
|---|---|---|
| `data` | object \| array | Main operation data payload. |
| `insert_data` | object | Upsert / insert-if-absent insert payload. |
| `update_data` | object | Upsert update payload. |
| `metadata` | object | Hidden `_metadata` object (documents) or app metadata (files). |
| `user_id` | string | Identity user selector, or the new document owner for a single explicit-ID `update`. |
| `max_docs` | int | Write cap: `-1` all, `0` no-op, `1+` cap. |
| `dry_run` | bool | Simulation mode; no write. |
| `commit` | bool | Per-request ack override: `true` committed, `false` accepted. |
| `replace` | bool | Fully replace one explicit-ID document. |
| `array_filters` | object | Named conditions for [positional array updates](#positional-array-updates). |
| `allow_system_timestamps` | bool | Allow `_created_at` / `_modified_at` in input where supported. |
| `unique_fields` | string[] | Insert-family soft uniqueness paths (dot notation). |
| `on_conflict` | string | Conflict policy; values differ per operation. |
| `lifecycle` | object \| object[] | Named scheduled conditional transitions. |

### Read shaping

| Field | Type | Description |
|---|---|---|
| `sort` | object \| string | Sort definition. |
| `fields` | string[] | Include projection paths. |
| `exclude_fields` | string[] | Exclude projection paths. `_id`, `_user_id`, and an included `_namespace` are always kept. |
| `limit` / `offset` | int | Offset pagination. |
| `page` / `per_page` | int | Page pagination (used when `limit`/`offset` are absent). |
| `include_namespace` | bool | Include `_namespace` (alias `include_name`). |
| `include_metadata` | bool | Include the hidden `_metadata` object. Hidden by default. |
| `include_archive` | bool | Read live + archived. |
| `archive_only` | bool | Read archived only. |
| `explain` | bool | Return generated WHERE SQL, bind count, and source instead of documents. |
| `cache` | bool \| int | Read cache policy. |
| `force_db` | bool | For exact `_id`/`_id.$in` reads, bypass the pending accepted-write overlay. |
| `compute` | object | [Compute operators](#compute-operators) spec. |
| `lookups` | object | [Lookup](#lookup-operators) map. |
| `lookup_depth_override` | int | Per-request lookup depth override. |
| `attach_users` | bool | Side-load Identity users referenced by `_user_id`. |
| `attach_user_fields` | string[] | Fields for attached users. Defaults to `id`, `first_name`, `last_name`, `profile_photo`; supports nested `data.*`. |
| `group_by` | string \| array | Metrics grouping. **Reserved and unimplemented in `aggregate`.** |

### TTL, archive, lifecycle

| Field | Type | Description |
|---|---|---|
| `ttl_seconds` | int | TTL seconds. `0` clears an existing TTL. |
| `expiry_behavior` | string | `archive` (default) or `delete`. |
| `purge` | bool | Hard-delete flag for delete/drop operations. |
| `txn_id` | string | Archive transaction selector (maps to `_txn_id`). |
| `transition_id` | string | Durable lifecycle transition selector. |
| `document_id` | string | Lifecycle document selector; `id` also accepted. |
| `at` | string | Lifecycle execution time (RFC3339 UTC). Mutually exclusive with `after_seconds`. |
| `after_seconds` | int | Positive lifecycle delay, resolved when the scheduling write commits. |
| `when` | object | Filter condition evaluated against the document at execution time. |
| `update` | object | Lifecycle patch or mutation operators applied when the condition matches. |
| `name` | string | Transition name, scoped to the document. |
| `execute_at_from` / `execute_at_to` | string | Inclusive RFC3339 bounds for `list_transitions`. |

### Batch operations

| Field | Type | Description |
|---|---|---|
| `operations` | array | Child envelopes for `multi_query` and `transaction`. |
| `alias` | string | Required unique child result name in `multi_query`; optional in `transaction`; also a metrics result alias. |
| `on_error` | string | `fail` (default) or `continue`. |

### Import and export

| Field | Type | Description |
|---|---|---|
| `source_path` | string | Local path or `s3://bucket/key` for `import_jsonl`. |
| `source_hash` | string | Source identity for import dedupe/validation. |
| `target_path` | string | Target path or prefix for `export_jsonl`. |
| `compress` | bool | Export compression toggle (default `true`). |
| `batch_size` | int | Import batch size. |
| `ignore_input_id` | bool | Import: drop incoming `_id`/`id`. `_key` remains ordinary data. |
| `include_system_timestamps` | bool | Export toggle for system timestamps. |
| `drop_keys` | string[] | Import-time field paths to remove. |
| `resumable` | bool | Import job resumable flag. |
| `expires_in` | int | Presigned URL lifetime (seconds); also an identity token offset. |
| `type` | string | Artifact type for `create_download_url`: `export`, `backup`, `snapshot`. |

### Jobs

| Field | Type | Description |
|---|---|---|
| `job_id` | string | Job selector. |
| `job_type` | string | Optional job type filter/hint. |
| `status` | string | Status filter for `list_jobs`; also an identity/file status value. |

### Database administration

| Field | Type | Description |
|---|---|---|
| `from_namespace` / `to_namespace` | string | Source/target for `change_namespace` and `rename_namespace`. |
| `to_db_path` | string | Target for `clone_db`. |
| `backup_db_path` | string | Backup/restore path. |
| `backup_id` / `backup_tag` / `backup_at` | string | Backup selectors (`backup_at` is RFC3339 UTC). |
| `latest` | bool | Restore/download selector: latest artifact. |
| `snapshot_id` | string | Snapshot selector. |
| `retain_segments` | int | WAL compaction retain count. |
| `index_name` / `index_path` | string | Index name / JSON path. |
| `enable` | bool | FTS flag for `enable_fts_index`. |
| `sql` | string | Statement for `sql_execute`. |
| `params` | array | Positional bind parameters for `sql_execute`. |
| `table` | string | Table name for `sql_get_table_schema`. |

`delete_db` and `purge_system_db` accept no payload options. Database deletion always creates its own archive-tagged backup target.

### Metrics

| Field | Type | Description |
|---|---|---|
| `event` / `events` | string / array | Event selector, or events to ingest. |
| `metrics` | array | Metric definitions. |
| `batch` | array | Multiple metrics queries in one request. |
| `start` / `end` | string | Query bounds (RFC3339 or `YYYY-MM-DD`). |
| `range` | string | Relative window, e.g. `24h`, `7d`, `last_month`. |
| `interval` | string | Bucket: `minute`, `hour`, `day`, `week`, `month`, `year`. |
| `label` | string | Result label; supports templates like `{{start YYYY-MM-DD}}`. |
| `bucket_label` | string | Item bucket label template, e.g. `{{bucket HH:mm}}`. |

### Identity

| Field | Type | Description |
|---|---|---|
| `email`, `username`, `phone` | string | User selectors / attributes. |
| `first_name`, `last_name`, `profile_photo` | string | First-class profile columns. |
| `provider` / `provider_user_id` | string | External provider name and stable external id. |
| `password_hash` / `password_algo` | string | App-generated hash and algorithm label. Kokoadb never stores raw passwords. |
| `include_credentials` | bool | `user_get` only. Default `false`; when true, adds `password_hash` and `password_algo` to the returned user item for backend verification. |
| `requires_password_change` | bool | Account signal for the app. Defaults to `false` on create. |
| `token_hash` / `token_id` | string | App-generated token hash; internal token selector. |
| `kind` | string | Token kind, e.g. `password_reset`, `email_verify`, `api_key`. |
| `allow_multi` | bool | Token option. Default `false` revokes active same-kind tokens. |
| `expires_at` / `expires_in` | string / int | Token expiration datetime or offset in seconds. |
| `status_reason` | string | Status reason. |
| `status_expires_at` / `status_expires_in` | string / int | Scheduled status transition time or offset. |
| `status_next` / `status_next_reason` | string | Status to apply on expiration, and its reason. |
| `changed_by` | string | Actor/service marker for status changes. |

### Files

| Field | Type | Description |
|---|---|---|
| `bucket` | string | Bucket/group name; defaults to `default`. |
| `storage_backend` | string | Backend marker, e.g. `local`, `s3`, `external`. |
| `storage_path` | string | Object location managed by the application. |
| `filename` / `content_type` | string | Display filename and MIME type. |
| `size_bytes` | int | File size, provided by the application. |
| `sha256` | string | Content checksum/fingerprint. |
| `owner_type` / `owner_id` | string | Generic owner attachment, e.g. `user` + `u123`. |
| `uploaded_at` | string | When the app/object store received the file. Defaults to server UTC now. |

---

## Operation index

Find the operation by task; the reference follows in the same order.

### Document data

| Operation | Required input | Purpose |
|---|---|---|
| [`insert`](#insert) | `namespace`, `payload.data` | Create one or many documents; optionally apply TTL, identity reference, generated values, soft uniqueness. |
| [`update`](#update) | Explicit `_id` data, or `filter` + `data` | Patch existing documents or replace one known document. Never inserts. |
| [`upsert`](#upsert) | `namespace`, `filter`, `insert_data` | Update filter matches, or insert one document when none exist. |
| [`count`](#count) | `namespace` or `scope: "all"` | Return only the number of matching documents. |
| [`query`](#query) | `namespace` string, array, or `"*"` | Return documents with filters, pagination, sorting, projection, FTS, lookups, compute, attachments. |
| [`multi_query`](#multi_query) | `operations[]` with unique `alias` | Run several independent read-only queries in one HTTP request. |
| [`aggregate`](#aggregate) | `compute`, namespace or all scope | Compute set-level counts, sums, averages, extrema, distinct values. |
| [`delete`](#delete) | Exactly one of `id`, `ids`, `filter` | Soft-delete into archive, or hard-delete with `purge: true`. |
| [`set_ttl`](#set_ttl) | `ids` or `filter`, plus `ttl_seconds` | Schedule or clear document expiration. |
| [`transaction`](#transaction) | `operations[]` | Run insert/update/upsert/delete children in one SQL transaction. |

### Document lifecycle

| Operation | Required input | Purpose |
|---|---|---|
| [`schedule_transition`](#schedule_transition) | `document_id`, `name`, time, `when`, `update` | Create or replace a named scheduled conditional mutation. |
| [`cancel_transition`](#cancel_transition-and-retry_transition) | `transition_id` or `document_id` + `name` | Cancel one pending transition, retaining history. |
| [`get_transition`](#get_transition-and-list_transitions) | Transition selector | Inspect one transition and its execution state. |
| [`list_transitions`](#get_transition-and-list_transitions) | None | Filter and paginate transition history. |
| [`retry_transition`](#cancel_transition-and-retry_transition) | Transition selector | Reopen a failed transition. Failures never auto-retry. |

### Import, export, jobs

| Operation | Required input | Purpose |
|---|---|---|
| [`import_jsonl`](#import_jsonl) | `namespace`, `source_path` | Queue streaming, resumable JSONL ingestion from local disk or S3. |
| [`export_jsonl`](#export_jsonl) | Namespace or all scope | Queue filtered, projection-aware JSONL export. |
| [`create_import_upload_url`](#browser-upload-to-s3) | `filename` | Presigned S3 `PUT` for a browser-side import upload. |
| [`create_download_url`](#presigned-downloads) | `type` + selector | Presigned S3 `GET` for a completed export, backup, or snapshot. |
| [`get_job`](#job-control) | `job_id` | Inspect one background job. |
| [`list_jobs`](#job-control) | None | Filter and paginate jobs. |
| [`continue_job`](#job-control) | `job_id` | Reopen supported failed/resumable work. |
| [`abort_job`](#job-control) | `job_id` | Mark supported work terminal and release its lease. |

### Product stores

| Operation | Required input | Purpose |
|---|---|---|
| [`metrics_ingest`](#metrics_ingest) | `events[]` | Append application metric events. |
| [`metrics_query`](#metrics_query) | Event selector, range, `metrics[]` | Produce bucketed and grouped result sets. |
| [`metrics_catalog`](#metrics_catalog) | None | Discover registered event names and dimension paths. |
| [`user_create`](#user_create) | None | Create Identity user metadata. |
| [`user_get`](#user_get) | User selector | Fetch one user by id, email, username, or provider identity; optionally include password-verification material. |
| [`user_get_details`](#user_get_details) | User selector | Fetch a user with providers, login methods, recent events. |
| [`user_query`](#user_query) | None | Search and paginate users. |
| [`user_update`](#user_update) | `user_id` or `id` | Update profile and application metadata. |
| [`user_update_password`](#user_update_password) | Selector, `password_hash`, `password_algo` | Atomically replace a password hash. |
| [`user_update_status`](#user_update_status) | Selector, `status` | Change status now or schedule a transition. |
| [`user_delete`](#user_delete) | User selector | Soft-delete a user or purge all identity state. |
| [`user_create_token`](#user_create_token) | Selector, `kind`, `token_hash` | Store a token hash with expiration and single/multi policy. |
| [`user_get_token`](#user_get_token) | `token_id`, or `token_hash` + `kind` | Read safe token metadata and derived status. |
| [`user_consume_token`](#user_consume_token) | `token_hash`, `kind` | Atomically consume an active token exactly once. |
| [`user_revoke_token`](#user_revoke_token) | Token or user selector | Revoke active tokens. |
| [`user_link_provider`](#user_link_provider) | Selector, `provider`, `provider_user_id` | Link an external identity provider. |
| [`user_unlink_provider`](#user_unlink_provider) | `provider`, `provider_user_id` | Remove an external provider link. |
| [`file_create`](#file_create) | `storage_backend`, `storage_path` | Register file/object metadata without moving bytes. |
| [`file_get`](#file_get) | `id` | Fetch one file metadata record. |
| [`file_query`](#file_query) | None | Search and paginate file metadata. |
| [`file_update`](#file_update) | `id` | Update mutable file metadata. |
| [`file_delete`](#file_delete) | `id` | Soft-delete or purge file metadata. |

### Namespace lifecycle

| Operation | Required input | Purpose |
|---|---|---|
| [`list_namespaces`](#list_namespaces) | None | List namespaces and their statistics. |
| [`get_namespace_stats`](#get_namespace_stats) | `namespace` | Live/archive counts and bytes for one namespace. |
| [`get_data_count`](#get_data_count) | None | Complete exact stored-data inventory for the database. |
| [`recompute_stats`](#recompute_stats) | None | Queue a full rebuild of namespace statistics. |
| [`drop_namespace`](#drop_namespace) | `namespace` | Archive all namespace documents, or permanently purge them. |
| [`restore_archive`](#restore_archive) | `txn_id`, `ids`, or namespace/filter | Restore archived documents with a conflict policy. |
| [`purge_archive`](#purge_archive) | `txn_id`, `ids`, or namespace/filter | Permanently delete selected archive rows. |
| [`change_namespace`](#change_namespace) | `from_namespace`, `to_namespace` | Move selected live documents to another namespace. |
| [`rename_namespace`](#rename_namespace) | `from_namespace`, `to_namespace` | Rename a namespace across live and archive data. |

### Database lifecycle and recovery

| Operation | Required input | Purpose |
|---|---|---|
| [`create_db`](#create_db) | `db` | Explicitly initialize a database path. |
| [`db_exists`](#db_exists) | `db` | Check local and, in S3 mode, remote existence. |
| [`load_db`](#s3-replication-and-snapshots) | `db` | Hydrate and preload an S3-backed database. |
| [`offload_db`](#s3-replication-and-snapshots) | `db` | Sync, close, and remove the local working copy. |
| [`sync_db`](#s3-replication-and-snapshots) | `db` | Force S3 WAL/snapshot/manifest synchronization. |
| [`create_snapshot`](#s3-replication-and-snapshots) | `db` | Documented alias of `sync_db`. |
| [`list_snapshots`](#s3-replication-and-snapshots) | `db` | List versioned snapshots. |
| [`restore_snapshot`](#s3-replication-and-snapshots) | `db`; optional `snapshot_id` | Hydrate from the latest or a selected snapshot. |
| [`get_sync_status`](#s3-replication-and-snapshots) | `db` | Inspect local and remote synchronization state. |
| [`verify_db`](#s3-replication-and-snapshots) | `db` | Verify referenced manifest, snapshot, and segment objects. |
| [`compact_wal`](#s3-replication-and-snapshots) | `db` | Compact retained WAL segment metadata. |
| [`clone_db`](#clone_db) | `db`, `to_db_path` | Copy the current database to a new path. |
| [`delete_db`](#delete_db) | `db` | Snapshot and archive-backup a database, then permanently remove its live local/S3 artifacts. |
| [`create_backup`](#backups) | `db` | Queue a compressed backup. |
| [`restore_backup`](#backups) | One backup selector | Restore from path, id, tag, timestamp, or latest. |
| [`list_backups`](#backups) | `db` | Browse the backup catalog. |
| [`tag_backup`](#backups) | Backup id or path | Set or clear a backup tag. |
| [`vacuum_db`](#vacuum_db-and-reap_db) | `db` | Queue SQLite compaction. |
| [`reap_db`](#vacuum_db-and-reap_db) | `db` | Run TTL/archive/lifecycle processing immediately. |

### SQL

| Operation | Required input | Purpose |
|---|---|---|
| [`sql_execute`](#sql_execute) | `sql` | Execute one supported parameterized read, write, or limited DDL statement. |
| [`sql_list_tables`](#sql_list_tables) | None | List user-created tables, hiding internals. |
| [`sql_get_table_schema`](#sql_get_table_schema) | `table` | Safely inspect a user table schema without arbitrary `PRAGMA`. |

### Indexes and search

| Operation | Required input | Purpose |
|---|---|---|
| [`create_index`](#manual-indexes) | `index_path` | Create a manual JSON expression index. |
| [`drop_index`](#manual-indexes) | `index_name` or `index_path` | Remove a manual or derived index. |
| [`list_indexes`](#manual-indexes) | None | List document-table indexes. |
| [`enable_fts_index`](#full-text-search) | None | Toggle database-level FTS access. |
| [`reindex_fts`](#full-text-search) | None | Queue FTS table creation/rebuild and backfill. |
| [`drop_fts_index`](#full-text-search) | None | Queue FTS table and trigger removal. |

### System and statistics

| Operation | Required input | Purpose |
|---|---|---|
| [`list_commands`](#instance-inventory) | None | Return public gateway command names. |
| [`list_dbs`](#instance-inventory) | None | List databases currently loaded by this instance. |
| [`list_all_dbs`](#instance-inventory) | None | Discover all known local and remote databases. |
| [`system_get_inventory`](#system-catalog) | None | Read cross-database inventory from `__kdb_system.db`. |
| [`system_refresh_inventory`](#system-catalog) | None | Refresh inventory from local/S3 discovery. |
| [`purge_system_db`](#system-catalog) | None | Delete and immediately rebuild the local system catalog. |
| [`system_get_db_status`](#system-catalog) | `db` | Combine live status with the system-catalog record. |
| [`system_snapshot_db_stats`](#system-catalog) | Optional `db` | Snapshot active-database statistics into the catalog. |
| [`system_query_db_stats`](#system-catalog) | None | Query system-catalog database history. |
| [`system_list_db_events`](#system-catalog) | None | Query database lifecycle/error events. |
| [`get_system_stats`](#runtime-statistics) | None | Instance uptime, requests, latency, memory, queues, rolling windows. |
| [`system_memory`](#runtime-statistics) | None | Compatibility memory/write-queue view. |
| [`cleanup_temp_artifacts`](#runtime-statistics) | None | Remove stale internal temporary files. |
| [`get_system_config`](#per-database-statistics) | `db` | Read per-database internal configuration. |
| [`get_db_stats`](#per-database-statistics) | `db` | Live in-memory counters for one database. |
| [`snapshot_db_stats`](#per-database-statistics) | `db` | Persist one per-database counter snapshot. |
| [`query_db_stats`](#per-database-statistics) | `db` | Query persisted per-database snapshots. |

---

## Data 

These are the primary API for storing and retrieving JSON. They all operate on the database named by top-level `db`. Unless an operation explicitly supports global scope, it also operates on one concrete `namespace`.

**Operations:**

1. `insert` creates documents without reading existing data.
2. `update` changes documents that already exist.
3. `upsert` chooses between update and insert using a filter.
4. `count` returns only the number of matches.
5. `query` returns documents, with FTS, pagination, projection, lookups, and per-row computation.
6. `multi_query` runs several independent queries through one request.
7. `aggregate` computes set-level values without returning documents.
8. `delete` soft-deletes or permanently purges.
9. `set_ttl` schedules or clears future expiration.
10. `transaction` atomically applies multiple mutations.

### Shared write behavior

`insert`, `update`, `upsert`, `delete`, and `set_ttl` are mutations and share these controls:

| Property | Type | Default | Meaning |
|---|---|---|---|
| `commit` | bool | Runtime config | `true` waits for the write coordinator to persist. `false` accepts and queues. Falls back to committed execution if the queue is unavailable. |
| `dry_run` | bool | `false` | Validates and evaluates the target without changing data. The response reports expected counts. |
| `max_docs` | int | Operation-specific | `-1` all matches, `0` no documents changed, `1+` caps the mutation. |

Committed responses include `committed: true` / `is_async_ack: false`. Accepted responses include `committed: false`, `is_async_ack: true`, `ack_mode: "accepted"`, `ack_status: "queued"`.

---

### `insert`

Creates one or many new JSON documents in one namespace. Use it when the request is inherently a create and existing documents must not be patched.

**Requirements**

- Top-level `namespace` is required and must be one concrete namespace. `"*"` and arrays are rejected.
- `payload.data` must be one non-empty object or a non-empty array of objects.

**Options**

| Property | Type | Default | Description |
|---|---|---|---|
| `data` | object \| object[] | **Required** | Document body or bodies. Every item must be an object. |
| `_user_id` | string | — | Identity user reference stored in the document-table column, not inside `data`. May also be supplied per document. |
| `metadata` | object | — | Hidden document metadata stored in the `_metadata` column. Not returned unless a read sets `include_metadata: true`. |
| `ttl_seconds` | int | — | Positive lifetime. The reaper processes it after expiration. |
| `expiry_behavior` | string | `archive` | `archive` moves an expired document to the archive; `delete` removes it. Unknown values normalize to `archive`. |
| `lifecycle` | object \| object[] | — | On a **single-document** insert, atomically creates named scheduled transitions. |
| `allow_system_timestamps` | bool | `false` | Allows `_created_at` / `_modified_at` in input. If only `_created_at` is supplied, `_modified_at` uses the same value. |
| `unique_fields` | string[] | `[]` | Namespace-scoped soft uniqueness key. Multiple paths form one composite key. Dot paths supported. |
| `on_conflict` | string | `skip` | With `unique_fields`: `skip` conflicting input, or return an `error`. |
| `commit` | bool | Runtime default | Committed or accepted acknowledgement. |
| `dry_run` | bool | `false` | Reports how many documents would be inserted or skipped. |

If `_id` is absent, Kokoadb generates a dashless UUIDv4. If supplied it must be a non-empty string. [Generator operators](#generator-operators) such as `@uuidv4` and `@now` are expanded before persistence.

#### Insert one

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "users",
  "payload": {
    "data": {"email": "ada@example.com", "name": "Ada"}
  }
}
```

#### Insert many

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "users",
  "payload": {
    "data": [
      {"email": "ada@example.com", "name": "Ada"},
      {"email": "grace@example.com", "name": "Grace"}
    ],
    "commit": false
  }
}
```

#### Insert with identity reference, TTL, and generated values

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "sessions",
  "payload": {
    "_user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "ttl_seconds": 7200,
    "expiry_behavior": "delete",
    "data": {
      "_id": {"@uuidv4": {"prefix": "session_"}},
      "created_by_app_at": {"@now": true},
      "state": "active"
    }
  }
}
```

#### Insert with composite uniqueness

Use this for idempotent creates keyed on an application value such as tenant + email. This is **not** a database constraint; Kokoadb checks the composite values within the target namespace during insertion.

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "users",
  "payload": {
    "data": {
      "tenant": {"id": "tenant_01"},
      "profile": {"email": "ada@example.com"},
      "name": "Ada"
    },
    "unique_fields": ["tenant.id", "profile.email"],
    "on_conflict": "error"
  }
}
```

#### Response

```json
{
  "status": "success",
  "data": {
    "count": 1,
    "inserted_count": 1,
    "skipped_count": 0,
    "items": [{
      "_id": "7835cb6159234c49955326a93adade8f",
      "email": "ada@example.com",
      "name": "Ada",
      "_created_at": "2026-08-07T12:00:00.000Z",
      "_modified_at": "2026-08-07T12:00:00.000Z"
    }]
  },
  "committed": true,
  "is_async_ack": false
}
```

---

### `update`

Changes documents that already exist. Use it when the caller knows a document `_id`, has an array of explicit ids, or intentionally wants to patch every record matched by a filter. **`update` never inserts a missing document.**

By default update data is a **JSON merge patch**: supplied fields change, untouched fields remain, nested objects update nested values. [Mutation operators](#mutation-operators) provide path-aware transformations for counters and arrays; their field keys may use dot notation.

The same patch behavior applies to Identity `user_update.data` and File `file_update.metadata`. Use `$replace` when a complete object at a path must be replaced — it works at the root of `data`/`metadata` or at any nested path, and its operand must be an object.

#### Accepted shapes

| Mode | Required input | Namespace rule | Use case |
|---|---|---|---|
| Single document | `data` object containing `_id` | Optional; strict when provided | Edit one known document. |
| Multiple explicit documents | `data` array; every object contains `_id` | Optional; strict when provided | Apply different patches to known documents. |
| Filter update | Non-empty `filter` plus one `data` object | Required unless `scope: "all"` | Apply one patch to matching documents. |

`payload.ids` is **not** accepted. For many explicit ids use `data: [...]`; for one shared patch use `filter: {"_id": {"$in": [...]}}`.

#### Options

| Property | Type | Default | Description |
|---|---|---|---|
| `data` | object \| object[] | **Required** | Patch object(s). Explicit-ID modes require `_id` on every object. |
| `user_id` | string | — | Reassigns the document's `_user_id` column. **Single explicit-ID update only.** Rejected for filter and array updates. |
| `metadata` | object | — | Replaces the `_metadata` object. **Single explicit-ID update only.** |
| `allow_system_timestamps` | bool | `false` | Allows root `_created_at` / `_modified_at` in update data. Values must be RFC3339 and are normalized to UTC. |
| `filter` | object | — | Non-empty filter for shared-patch mode. Cannot be combined with an array. |
| `replace` | bool | `false` | Fully replaces one explicit-ID document while preserving `_id`. Rejected for arrays and filter mode. |
| `lifecycle` | object \| object[] | — | Single explicit-ID mode only. Creates or replaces named transitions after the update; transitions with other names remain. |
| `max_docs` | int | All matches | Caps filter mode. |
| `scope` | string | `namespace` | Use `all` only for an intentional cross-namespace filter update. |
| `commit` | bool | Runtime default | Committed or accepted acknowledgement. |
| `dry_run` | bool | `false` | Validates and reports matched/update counts without writing. |

**Targeting rules**

- An explicit-ID update **without** a namespace searches globally by `_id`. Supplying a namespace asserts the document belongs to it.
- Missing ids are skipped, never created.
- `data._user_id`, `data._metadata`, and any path rooted at either are **always rejected**. Use the sibling `payload.user_id` / `payload.metadata` properties.
- `_namespace` and `_namespace.*` keys in update data are treated as response noise and discarded rather than persisted — so echoing a queried document back is safe.

**System timestamps**

Root `_created_at` and `_modified_at` are rejected by default. With `allow_system_timestamps: true`, each supplied value must be RFC3339 and is normalized to UTC. When `_modified_at` is omitted, a successful update still refreshes it to the current UTC time. Dotted paths rooted at either timestamp remain invalid. This applies to standalone updates, accepted-write previews, explicit update arrays, filter updates, and transaction updates. Upsert `update_data` and lifecycle transition patches continue to reject system timestamps.

**Metadata and ownership**

`metadata` is maintained separately from the document body. It must be a JSON object and replaces the complete `_metadata` object; use `{}` to clear it. Metadata updates require one explicit `data._id`, may omit all other data fields, refresh `_modified_at`, and follow the request's normal acknowledgement mode. They are intentionally unsupported in filter and array modes because those can target multiple documents. `user_id` follows the same single-document restriction and is never merged into document JSON.

#### Patch one document

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "users",
  "payload": {
    "data": {
      "_id": "u1",
      "name": "Ada Lovelace",
      "profile": {"city": "London"}
    }
  }
}
```

#### Patch multiple explicit documents

```json
{
  "db": "myapp/main",
  "operation": "update",
  "payload": {
    "data": [
      {"_id": "u1", "status": "active"},
      {"_id": "u2", "status": "inactive"}
    ],
    "commit": false
  }
}
```

#### Update by filter

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "users",
  "payload": {
    "filter": {
      "plan": "trial",
      "created_at": {"$lt": "2026-01-01T00:00:00Z"}
    },
    "data": {"plan": "expired"},
    "max_docs": 500,
    "dry_run": false
  }
}
```

#### Update ownership and hidden metadata

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "orders",
  "payload": {
    "user_id": "identity-456",
    "metadata": {"migration": "legacy-v2"},
    "data": {
      "_id": "order-123",
      "status": "processed"
    }
  }
}
```

#### Update system timestamps explicitly

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "orders",
  "payload": {
    "allow_system_timestamps": true,
    "data": {
      "_id": "order-123",
      "_created_at": "2025-12-24T23:39:26.873397+00:00",
      "_modified_at": "2026-09-05T14:30:00-04:00"
    }
  }
}
```

The stored values become `2025-12-24T23:39:26.873Z` and `2026-09-05T18:30:00.000Z`.

#### Use mutation operators

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "users",
  "payload": {
    "data": {
      "_id": "u1",
      "login_count": {"$inc": 1},
      "events": {"$push": {"type": "login"}},
      "roles": {"$addset": "editor"},
      "temporary_code": {"$unset": true}
    }
  }
}
```

#### Replace one document

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "users",
  "payload": {
    "replace": true,
    "data": {"_id": "u1", "name": "Ada", "plan": "pro"}
  }
}
```

---

### `upsert`

Updates documents matched by a non-empty filter, or inserts one document when no match exists. Use it for synchronization and natural-key writes.

**`upsert` is intentionally singular on the insert path.** `insert_data` and `update_data` are objects, not arrays. It is not a bulk-upsert operation — use `transaction` or explicit application batching for unrelated upserts.

#### Options

| Property | Type | Default | Description |
|---|---|---|---|
| `filter` | object | **Required** | Non-empty filter used to find existing documents. |
| `insert_data` | object | **Required** | Non-empty document used only when the filter has no matches. `_id` is rejected here. |
| `update_data` | object | Required when `max_docs != 0` | Patch used only when matches exist. `_id` is rejected here. |
| `_user_id` | string | — | Identity reference stored on a newly inserted document. |
| `ttl_seconds` | int | — | Positive TTL applied **only** on the insert path. |
| `expiry_behavior` | string | `archive` | Expiry behavior applied only on the insert path. |
| `lifecycle` | object \| object[] | — | Requires `max_docs: 1`. Schedules transitions for the one updated or inserted document. |
| `max_docs` | int | `1` | Maximum existing matches to update. `0` updates none but still inserts when absent; `-1` updates all matches. |
| `commit` | bool | Runtime default | Accepted upserts return an acknowledgement rather than a prepared document. |
| `dry_run` | bool | `false` | Reports whether the operation would update or insert. |

A literal `filter._id` or `filter._id.$eq` string becomes the inserted `_id` when no match exists. For all other filters, Kokoadb generates a dashless UUIDv4. `_id` remains prohibited inside both data objects to prevent contradictory identity inputs.

#### Update or insert by natural key

```json
{
  "db": "myapp/main",
  "operation": "upsert",
  "namespace": "users",
  "payload": {
    "filter": {"email": "ada@example.com"},
    "insert_data": {
      "email": "ada@example.com",
      "name": "Ada",
      "login_count": 1
    },
    "update_data": {
      "last_seen": {"@now": true},
      "login_count": {"$inc": 1}
    },
    "max_docs": 1
  }
}
```

#### Insert if absent

With `max_docs: 0`, existing matches remain unchanged and `update_data` is optional. A missing match is still inserted.

```json
{
  "db": "myapp/main",
  "operation": "upsert",
  "namespace": "settings",
  "payload": {
    "filter": {"key": "site_theme"},
    "insert_data": {"key": "site_theme", "value": "light"},
    "max_docs": 0
  }
}
```

#### Upsert a known id

```json
{
  "db": "myapp/main",
  "operation": "upsert",
  "namespace": "users",
  "payload": {
    "filter": {"_id": {"$eq": "user_external_123"}},
    "insert_data": {"name": "Ada"},
    "update_data": {"name": "Ada Lovelace"}
  }
}
```

---

### `delete`

Removes one or many live documents. By default deletion is **recoverable**: each matched document is copied to `__kdb_archive` with its original timestamps and namespace, the operation is assigned one `_txn_id`, and the live rows are removed. Use `purge: true` only when data must be permanently removed without entering the archive.

#### Selectors

Exactly one is required.

| Selector | Namespace rule | Use case |
|---|---|---|
| `id` | Optional; strict if supplied | Delete one globally unique document id. |
| `ids` | Optional; strict if supplied | Delete several explicit ids. |
| `filter` | Required unless `scope: "all"` | Delete documents selected by filter operators. |

#### Options

| Property | Type | Default | Description |
|---|---|---|---|
| `id` | string | — | One explicit document id. |
| `ids` | string[] | — | Explicit ids. Cannot be combined with `id` or `filter`. |
| `filter` | object | — | Non-empty filter expression. |
| `purge` | bool | `false` | `false` soft-deletes; `true` permanently deletes live rows. |
| `ttl_seconds` | int | Configured delete TTL | Retention time for newly archived rows. Ignored with `purge: true`. |
| `max_docs` | int | All selected | Caps explicit ids or filter matches. |
| `scope` | string | `namespace` | `all` permits an intentional cross-namespace filter delete. |
| `commit` | bool | Runtime default | Committed or accepted acknowledgement. |
| `dry_run` | bool | `false` | Reports targets without deleting or archiving. |

#### Soft-delete one id globally

```json
{
  "db": "myapp/main",
  "operation": "delete",
  "payload": {"id": "u1"}
}
```

#### Soft-delete explicit ids strictly within a namespace

```json
{
  "db": "myapp/main",
  "operation": "delete",
  "namespace": "users",
  "payload": {
    "ids": ["u1", "u2"],
    "ttl_seconds": 604800
  }
}
```

#### Delete by filter with a safety cap

```json
{
  "db": "myapp/main",
  "operation": "delete",
  "namespace": "sessions",
  "payload": {
    "filter": {
      "status": "expired",
      "last_seen": {"$lt": "2026-01-01T00:00:00Z"}
    },
    "max_docs": 1000,
    "dry_run": true
  }
}
```

#### Permanently purge

```json
{
  "db": "myapp/main",
  "operation": "delete",
  "payload": {
    "ids": ["temporary-1", "temporary-2"],
    "purge": true
  }
}
```

A successful soft delete returns `_txn_id`. Keep it — it is the handle for [`restore_archive`](#restore_archive) and [`purge_archive`](#purge_archive).

---

### `count`

Returns only the number of documents matched by namespace, filter, user scope, and archive source. Cheaper and smaller than querying documents solely to count them.

| Property | Type | Default | Description |
|---|---|---|---|
| `filter` | object | `{}` | Filter conditions. |
| `_user_id` | string | — | Restricts to the document-table user reference. |
| `scope` | string | `namespace` | `namespace` requires a selected namespace; `all` counts across namespaces. `namespace: "*"` normalizes to `all`. |
| `include_archive` | bool | `false` | Counts live and archived together. |
| `archive_only` | bool | `false` | Counts archived only. |
| `cache` | bool \| int | Configured default | See [read caching](#read-caching). |

```json
{
  "db": "myapp/main",
  "operation": "count",
  "namespace": "users",
  "payload": {
    "filter": {"status": "active"},
    "cache": true
  }
}
```

```json
{ "status": "success", "data": {"count": 42} }
```

---

### `query`

The general-purpose read operation. It replaces separate get/search endpoints: use an `_id` filter for direct retrieval and `payload.search` for full-text search.

Reach for `query` when you need document bodies, pagination, sorting, field projection, nested lookups, per-row computed values, user attachments, archive reads, or FTS relevance.

#### Namespace selection

| Selector | Behavior |
|---|---|
| `namespace: "users"` | Reads one namespace. |
| `namespace: ["users","admins"]` | Reads several; automatically includes `_namespace`. |
| `namespace: "*"` | Reads all; automatically includes `_namespace`. |
| `operation: "query::users"` | Shorthand for one namespace. |
| `operation: "query::users,admins"` | Shorthand for several. |
| `operation: "query::*"` | Shorthand for all. |

#### Options

| Property | Type | Default | Description |
|---|---|---|---|
| `filter` | object | `{}` | Filter expression. Use `_id`, `_id.$eq`, or `_id.$in` for direct id retrieval. |
| `search` | string | — | Enables FTS5 over live documents. Alias `q`. |
| `_user_id` | string | — | Restricts documents by their external user reference column. |
| `sort` | string \| object | `_created_at DESC` | Ordered fields. String form supports comma-separated `path ASC\|DESC`; missing direction means ascending. Dot paths supported. |
| `limit` | int | `KOKOADB_QUERY_DEFAULT_LIMIT` | Page size for offset mode. |
| `offset` | int | `0` | Zero-based row offset. |
| `page` | int | `1` | One-based page number when offset mode is not used. |
| `per_page` | int | Configured limit | Page size used with `page`. |
| `fields` | string[] | All | Include only these paths. `_id`, `_user_id`, and an included `_namespace` are retained. |
| `exclude_fields` | string[] | `[]` | Remove these paths after inclusion. Protected fields cannot be excluded. |
| `include_namespace` | bool | Configured | Adds `_namespace`. Alias `include_name`. |
| `include_metadata` | bool | `false` | Includes the hidden `_metadata` object. |
| `include_archive` | bool | `false` | Reads live and archived. **Not available in FTS mode.** |
| `archive_only` | bool | `false` | Reads archived only. **Not available in FTS mode.** |
| `lookups` | object | — | Named lookup map for joining related documents. |
| `lookup_depth_override` | int | Configured max | Overrides lookup depth when uncapped override is enabled. |
| `compute` | object | — | Adds per-row computed fields after retrieval and lookups. |
| `attach_users` | bool | `false` | Side-loads Identity users referenced by `_user_id`. |
| `attach_user_fields` | string[] | `id`, `first_name`, `last_name`, `profile_photo` | Top-level or nested `data.*` fields for attachments. |
| `force_db` | bool | `false` | For exact `_id`/`_id.$in` reads, bypasses accepted-write pending state. |
| `explain` | bool | `false` | Returns generated WHERE SQL, bind count, and source instead of documents. |
| `cache` | bool \| int | Configured | See [read caching](#read-caching). |

#### Filter, sort, projection, pagination

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": {
    "filter": {
      "status": "active",
      "profile.age": {"$gte": 18}
    },
    "sort": "profile.age desc, name asc",
    "fields": ["_id", "name", "profile.age", "status"],
    "exclude_fields": ["internal_notes"],
    "page": 2,
    "per_page": 25,
    "cache": true
  }
}
```

#### Retrieve ids globally

Exact-id reads overlay pending accepted inserts and explicit-ID updates by default. Set `force_db: true` when the caller must observe only durable SQLite state.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "*",
  "payload": {
    "filter": {"_id": {"$in": ["u1", "u2", "u3"]}},
    "force_db": false
  }
}
```

#### Full-text query

FTS mode requires `enable_fts_index` to be true for the database and a populated index built by `reindex_fts`. It searches **live documents only**. Default order is `_search_score ASC, _created_at DESC`; lower BM25 scores rank first.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "articles",
  "payload": {
    "search": "sqlite AND json",
    "filter": {"status": "published"},
    "sort": "_search_score asc, _created_at desc",
    "fields": ["_id", "title", "summary", "_search_score"],
    "page": 1,
    "per_page": 20
  }
}
```

`_search_score` may only be used as a sort path during FTS mode. Archive flags are rejected in FTS mode.

#### Query with user attachments

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "orders",
  "payload": {
    "filter": {"status": "paid"},
    "attach_users": true,
    "attach_user_fields": ["id", "first_name", "last_name", "profile_photo", "data.display_name"]
  }
}
```

The response de-duplicates users into an attachment map:

```json
{
  "status": "success",
  "data": {
    "count": 1,
    "total_items": 1,
    "items": [
      {"_id": "order1", "_user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "status": "paid"}
    ],
    "attachments": {
      "users": {
        "f9c1b3a9e2a84f9aa0bdb88e8c12f001": {
          "id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
          "first_name": "Ada",
          "last_name": "Lovelace",
          "profile_photo": "s3://avatars/ada.png",
          "data": {"display_name": "Ada"}
        }
      }
    }
  }
}
```

---

### `multi_query`

Executes multiple independent document queries against one database in one HTTP request. It is a **read-only** batch wrapper around the same engine as `query`; child queries keep normal filtering, FTS, cache, pagination, projection, lookups, compute, pending-document reads, and user attachments.

Use it when one application screen needs several datasets from the same database. It removes round trips without combining datasets or changing query semantics.

> `multi_query` is **not a transaction** and does not provide a shared read snapshot. Children execute sequentially on the same connection in request order, under one `KOKOADB_OPERATION_TIMEOUT_MS` deadline. Cache keys and auto-index heatmap observations remain independent per child.

#### Request shape

```json
{
  "db": "myapp/main",
  "operation": "multi_query",
  "payload": {
    "on_error": "fail",
    "operations": [
      {
        "alias": "users",
        "namespace": "users",
        "payload": {
          "filter": {"status": "active"},
          "sort": "name asc",
          "page": 1,
          "per_page": 10
        }
      },
      {
        "alias": "open_orders",
        "namespace": "orders",
        "payload": {
          "filter": {"status": "open"},
          "fields": ["_id", "user_id", "total"],
          "limit": 25
        }
      }
    ]
  }
}
```

`db` and `operation` belong only to the outer request. Every child is always a document `query`.

#### Batch options

| Property | Type | Default | Description |
|---|---|---|---|
| `operations` | object[] | **Required** | Between 1 and `KOKOADB_QUERY_MULTI_MAX_QUERIES` (default 20) child queries. |
| `on_error` | string | `fail` | `fail` returns the first runtime error as a request error. `continue` returns successful and failed child results together. |

#### Child shape

| Property | Type | Required | Description |
|---|---|---|---|
| `alias` | string | **Yes** | Non-empty unique result identifier, repeated in the result. |
| `namespace` | string \| string[] | **Yes** | One, several, or `"*"`. Arrays must be non-empty; `"*"` cannot be combined with other values. |
| `operation` | string | No | May be omitted because `query` is implied. If supplied it must be `query`. |
| `payload` | object | No | Any normal `query` payload. |

The namespace selector must be a property of the **child item**, not inside its `payload`. Empty batches, missing or duplicate aliases, missing selectors, nested `operations`, invalid `on_error`, and oversized batches are rejected before any child executes. The legacy `payload.queries` and `namespaces` shapes are not accepted.

#### Structured and full-text queries together

```json
{
  "db": "myapp/main",
  "operation": "multi_query",
  "payload": {
    "operations": [
      {
        "alias": "recent_users",
        "namespace": "users",
        "payload": {"filter": {"status": "active"}, "sort": "_created_at desc", "limit": 10}
      },
      {
        "alias": "matching_articles",
        "namespace": "articles",
        "payload": {"search": "sqlite AND json", "fields": ["_id", "title", "_search_score"], "limit": 10}
      }
    ]
  }
}
```

#### Successful response

Each successful child's `data` object is exactly what the equivalent standalone `query` would return.

```json
{
  "status": "success",
  "data": {
    "count": 2,
    "succeeded": 2,
    "failed": 0,
    "results": [
      {
        "alias": "users",
        "status": "success",
        "data": {
          "count": 1, "total_items": 12, "items": [],
          "limit": 10, "offset": 0, "next_offset": 10, "prev_offset": null,
          "pagination": {}
        }
      },
      {
        "alias": "open_orders",
        "status": "success",
        "data": {
          "count": 4, "total_items": 4, "items": [],
          "limit": 25, "offset": 0, "next_offset": null, "prev_offset": null,
          "pagination": {}
        }
      }
    ]
  }
}
```

#### Continue on runtime errors

```json
{
  "db": "myapp/main",
  "operation": "multi_query",
  "payload": {
    "on_error": "continue",
    "operations": [
      {"alias": "users", "namespace": "users", "payload": {"limit": 10}},
      {"alias": "orders", "namespace": "orders", "payload": {"sort": "name sideways"}}
    ]
  }
}
```

```json
{
  "status": "partial",
  "data": {
    "count": 2,
    "succeeded": 1,
    "failed": 1,
    "results": [
      {"alias": "users", "status": "success", "data": {}},
      {
        "alias": "orders",
        "status": "error",
        "error": {"code": "bad_request", "message": "sort direction must be ASC or DESC in string mode"}
      }
    ]
  }
}
```

`partial` appears only when `on_error: "continue"` captures at least one runtime failure. With the default `fail`, the first runtime error ends execution and uses the normal gateway error response. Structural validation always fails the whole request before execution.

---

### `aggregate`

Computes set-level values over all documents matched by a namespace and filter. Unlike `query.compute` — which computes a value per returned item — `aggregate` summarizes the whole matched set and returns no document list.

| Property | Type | Default | Description |
|---|---|---|---|
| `compute` | object | **Required** | Named aggregate expressions using `$count`, `$sum`, `$avg`, `$min`, `$max`, `$distinct`. |
| `filter` | object | `{}` | Applied before aggregation. |
| `scope` | string | `namespace` | One namespace, or `all` / `namespace: "*"`. |
| `include_archive` | bool | `false` | Aggregates live and archived. |
| `archive_only` | bool | `false` | Aggregates archived only. |
| `cache` | bool \| int | Configured | Result caching. |
| `group_by` | any | **Unsupported** | Reserved; requests currently fail when supplied. Use [`metrics_query`](#metrics_query) for grouped series. |

```json
{
  "db": "myapp/main",
  "operation": "aggregate",
  "namespace": "orders",
  "payload": {
    "filter": {"status": "paid"},
    "compute": {
      "orders": {"$count": "*"},
      "revenue": {"$sum": "total"},
      "average_order": {"$avg": "total"},
      "smallest_order": {"$min": "total"},
      "largest_order": {"$max": "total"},
      "currencies": {"$distinct": "currency"}
    },
    "cache": 60
  }
}
```

```json
{
  "status": "success",
  "data": {
    "matched_count": 125,
    "compute": {
      "orders": 125,
      "revenue": 18420.5,
      "average_order": 147.364,
      "smallest_order": 9.99,
      "largest_order": 1250,
      "currencies": ["USD", "CAD"]
    }
  }
}
```

---

### `set_ttl`

Schedules selected live documents for future expiration, or clears an existing expiration. Use it when retention is decided after insertion — expiring sessions, temporary exports, invitations, stale records.

When a document reaches `_expires_at` the reaper applies `_expiry_behavior`: `archive` moves it to `__kdb_archive`; `delete` removes it permanently.

> This is different from `delete.ttl_seconds`, which controls how long an **already soft-deleted archive row** is retained.

| Property | Type | Default | Description |
|---|---|---|---|
| `ids` | string[] | Selector | Explicit ids. Namespace optional and strict when supplied. |
| `filter` | object | Selector | Non-empty filter. Namespace required unless `scope: "all"`. |
| `ttl_seconds` | int | **Required** | Positive seconds schedule expiration; `0` clears `_expires_at`. Negative values are rejected. |
| `expiry_behavior` | string | Existing value | `archive` or `delete`. Omitted leaves each document unchanged. Unknown values normalize to `archive`. |
| `max_docs` | int | All selected | Caps ids or filter matches. |
| `scope` | string | `namespace` | `all` permits cross-namespace filter targeting. |
| `commit` | bool | Runtime default | Committed or accepted acknowledgement. |
| `dry_run` | bool | `false` | Reports selected rows without changing TTL. |

`ids` and `filter` are mutually exclusive. Unlike `delete`, `set_ttl` does **not** accept singular `id` — use `ids: ["..."]`.

```json
{
  "db": "myapp/main",
  "operation": "set_ttl",
  "namespace": "sessions",
  "payload": {
    "ids": ["session_1", "session_2"],
    "ttl_seconds": 3600,
    "expiry_behavior": "delete"
  }
}
```

```json
{
  "db": "myapp/main",
  "operation": "set_ttl",
  "namespace": "invitations",
  "payload": {
    "filter": {"status": "unused"},
    "ttl_seconds": 86400,
    "expiry_behavior": "archive",
    "max_docs": 500
  }
}
```

Clear a TTL:

```json
{
  "db": "myapp/main",
  "operation": "set_ttl",
  "payload": {"ids": ["session_1"], "ttl_seconds": 0}
}
```

---

### `transaction`

Applies a sequence of document mutations inside **one SQL transaction**. The default `on_error: "fail"` is all-or-nothing; optional `continue` mode isolates failed children with savepoints and commits the successful ones.

Nested operations may target different namespaces but always use the single database selected by the outer `db`.

#### Requirements

- `payload.operations` must be a non-empty array of complete operation envelopes.
- Supported nested operations: `insert`, `update`, `upsert`, `delete`.
- Each child supplies its own `namespace` and `payload` per that operation's normal rules.
- A child cannot override the outer database.
- `payload.on_error` accepts `fail` (default) or `continue`.

#### Options

| Property | Type | Default | Description |
|---|---|---|---|
| `operations` | object[] | **Required** | Ordered list of `insert`, `update`, `upsert`, or `delete` child envelopes. |
| `on_error` | string | `fail` | `fail` rolls back everything on the first runtime error. `continue` rolls back only the failed child's savepoint. |

Child `alias` is optional and, when supplied, is repeated in the corresponding result entry.

#### Semantics

- With `fail`, the first nested runtime error rolls back the entire transaction.
- With `continue`, every child runs under its own SQLite savepoint. A failed child is rolled back to its savepoint, remaining children continue, and successful children commit together.
- Nested `insert` supports `unique_fields` and `on_conflict: "skip" | "error"`. The check runs inside the active transaction, so it sees both existing documents **and earlier nested inserts**.
- **Nested transaction inserts default `on_conflict` to `error`**, unlike standalone `insert`. An explicit `skip` is a successful no-op, independent of `on_error`.
- A skipped unique insert creates neither its document nor its lifecycle transitions; it is counted under `skipped_count`.
- Nested `upsert` preserves standalone filter, `insert_data`, `update_data`, `max_docs`, TTL, expiry behavior, mutation operator, dry-run, `_user_id`, and singular lifecycle behavior. Every nested upsert evaluates its filter against the transaction's current state, so it sees earlier children's mutations.
- Upsert result entries include `data.action` as `inserted`, `updated`, or `no_change`.
- Singular `insert`, explicit-ID `update`, and `upsert` with `max_docs: 1` may carry `lifecycle` definitions; the document mutation and transition rows commit or roll back together. A transactional soft delete cancels pending transitions for its document.

#### Example

```json
{
  "db": "myapp/main",
  "operation": "transaction",
  "payload": {
    "operations": [
      {
        "operation": "insert",
        "namespace": "users",
        "payload": {"data": {"_id": "u1", "name": "Ada"}}
      },
      {
        "operation": "update",
        "namespace": "accounts",
        "payload": {"data": {"_id": "account-1", "owner_id": "u1"}}
      }
    ]
  }
}
```

Use `transaction` for short, related mutation sets. Large ingestion belongs in `insert` with array data or resumable `import_jsonl`.

#### Transactional upsert

```json
{
  "db": "myapp/main",
  "operation": "transaction",
  "payload": {
    "operations": [
      {
        "alias": "ensure-user",
        "operation": "upsert",
        "namespace": "users",
        "payload": {
          "filter": {"email": "ada@example.com"},
          "insert_data": {"email": "ada@example.com", "login_count": 1},
          "update_data": {"login_count": {"$inc": 1}},
          "max_docs": 1
        }
      }
    ]
  }
}
```

The child result identifies which branch ran:

```json
{
  "index": 0,
  "alias": "ensure-user",
  "operation": "upsert",
  "namespace": "users",
  "status": "success",
  "data": {
    "action": "updated",
    "count": 1,
    "matched_count": 1,
    "updated_count": 1,
    "inserted_count": 0,
    "items": [{"_id": "7c93f1738dd9472280c56b04cef1209c", "email": "ada@example.com", "login_count": 2}]
  }
}
```

#### Response shape

`count` is the number of nested envelopes. `succeeded`, `failed`, and `skipped_count` partition the outcomes; `results[]` preserves request order.

```json
{
  "status": "success",
  "data": {
    "count": 2,
    "succeeded": 1,
    "failed": 0,
    "skipped_count": 1,
    "results": [
      {"index": 0, "operation": "insert", "namespace": "users", "status": "success"},
      {
        "index": 1,
        "operation": "insert",
        "namespace": "users",
        "status": "skipped",
        "reason": {"code": "unique_fields_conflict", "message": "insert skipped by on_conflict policy"}
      }
    ],
    "message": "transaction_committed"
  },
  "committed": true,
  "is_async_ack": false
}
```

#### Continue after a failed child

Use `continue` only when successful children may commit independently of failed ones. This is a **partial transaction policy**, not all-or-nothing atomicity.

```json
{
  "db": "myapp/main",
  "operation": "transaction",
  "payload": {
    "on_error": "continue",
    "operations": [
      {
        "alias": "create-user",
        "operation": "insert",
        "namespace": "users",
        "payload": {"data": {"_id": "u1", "name": "Ada"}}
      },
      {
        "alias": "broken-update",
        "operation": "update",
        "namespace": "accounts",
        "payload": {"data": {"plan": "pro"}}
      }
    ]
  }
}
```

The update fails because `data._id` is missing. Its savepoint rolls back, the insert commits, and the response reports `status: "partial"`, `succeeded: 1`, `failed: 1`. Structural errors — a missing child `operation`, an unsupported operation name, an empty batch, an invalid `on_error` — are rejected before the SQL transaction begins.

---

### Operators

The document API uses four named operator families plus a smaller relationship-specific one.

| Family | Used in | Purpose |
|---|---|---|
| [Filter operators](#filter-operators) | `payload.filter`, lookup `filter`, lifecycle `when`, `array_filters` | Select documents by field values and logical conditions. |
| [Compute operators](#compute-operators) | `payload.compute` | Produce aggregate values, or fields derived from each returned document. |
| [Generator operators](#generator-operators) | `data`, `insert_data`, `update_data` | Generate timestamps, identifiers, and hashes before persistence. |
| [Mutation operators](#mutation-operators) | `update` data objects | Transform existing numbers, arrays, and fields in place. |
| [Lookup match operators](#lookup-match-operators) | `payload.lookups.*.match` | Describe the direction of a document relationship. |

Projection is **not** an operator family: `fields` and `exclude_fields` shape the response after lookup and compute processing.

---

### Filter operators

A filter is an object whose ordinary keys are document field paths and whose `$` keys are operators. Dot notation addresses nested fields. Multiple fields in one object are implicitly joined with **AND**.

```json
{
  "status": "active",
  "profile.age": {"$gte": 18}
}
```

That means `status == "active"` **and** `profile.age >= 18`. A bare scalar is equivalent to `$eq`.

Multiple operators on one field are also ANDed:

```json
{ "profile.age": {"$gte": 18, "$lt": 65} }
```

#### Logical

| Operator | Operand | Definition | Example |
|---|---|---|---|
| `$and` | Non-empty filter array | Every child must match. | `{"$and":[{"status":"active"},{"age":{"$gte":18}}]}` |
| `$or` | Non-empty filter array | At least one child must match. | `{"$or":[{"plan":"pro"},{"plan":"team"}]}` |
| `$nor` | Non-empty filter array | None of the children may match. | `{"$nor":[{"status":"banned"},{"status":"deleted"}]}` |
| `$not` | One filter object | Negates the nested filter. | `{"$not":{"profile.country":"US"}}` |

#### Comparison

| Operator | Operand | Definition | Example |
|---|---|---|---|
| `$eq` | Scalar | Field equals the operand. | `{"status":{"$eq":"active"}}` |
| `$ne` | Scalar | Field does not equal the operand. | `{"status":{"$ne":"deleted"}}` |
| `$gt` | Comparable scalar | Greater than. | `{"score":{"$gt":100}}` |
| `$gte` | Comparable scalar | Greater than or equal. | `{"profile.age":{"$gte":18}}` |
| `$lt` | Comparable scalar | Less than. | `{"price":{"$lt":50}}` |
| `$lte` | Comparable scalar | Less than or equal. | `{"attempts":{"$lte":3}}` |
| `$between` | Exactly two values | Inclusively between lower and upper. | `{"profile.age":{"$between":[18,65]}}` |
| `$exists` | Boolean | `true` requires a non-null path; `false` requires missing or null. | `{"profile.phone":{"$exists":true}}` |

#### Membership and arrays

| Operator | Operand | Definition | Example |
|---|---|---|---|
| `$in` | Non-empty array | Scalar field equals any operand value. | `{"status":{"$in":["active","trial"]}}` |
| `$nin` | Non-empty array | Scalar field equals none of them. | `{"status":{"$nin":["deleted","banned"]}}` |
| `$includes` | One value | Array field contains the value. | `{"tags":{"$includes":"paid"}}` |
| `$nincludes` | One value | Array field does not contain the value. | `{"roles":{"$nincludes":"blocked"}}` |
| `$all` | Non-empty array | Array field contains every supplied value. | `{"tags":{"$all":["paid","beta"]}}` |
| `$any` | Non-empty array | Array field contains at least one. | `{"roles":{"$any":["admin","owner"]}}` |
| `$none` | Non-empty array | Array field contains none of them. | `{"flags":{"$none":["fraud","blocked"]}}` |
| `$elemMatch` | Filter object | At least one array element satisfies the complete nested filter. | `{"items":{"$elemMatch":{"sku":"A1","qty":{"$gte":2}}}}` |
| `$size` | Integer or comparison object | Array length equals or compares against the operand. | `{"roles":{"$size":{"$gte":2}}}` |

`$size` accepts an integer directly, or `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`:

```json
{ "members": {"$size": 3}, "events": {"$size": {"$gt": 0}} }
```

#### Array wildcards

Use `[]` in a field path when the element index is unknown. **Each wildcard path is an independent existential condition.**

```json
{
  "people[].name": "Ada",
  "people[].age": {"$gte": 18}
}
```

This means *some* element has `name == "Ada"` and *some* element has `age >= 18` — possibly different elements. Use `$elemMatch` when all conditions must match the **same** element.

- Wildcards may be nested: `departments[].teams[].members[].name`.
- Scalar arrays work: `{"scores[]": {"$gte": 90}}`.
- Only the exact `[]` suffix is accepted; `[*]` is invalid.
- Wildcard paths work anywhere the shared filter compiler is used — document filters, identity `data.*` filters, and file `metadata.*` filters.

#### String

| Operator | Operand | Definition | Example |
|---|---|---|---|
| `$startsWith` | String | Prefix match via SQLite `LIKE`. | `{"email":{"$startsWith":"admin@"}}` |
| `$endsWith` | String | Suffix match via `LIKE`. | `{"email":{"$endsWith":"@example.com"}}` |
| `$contains` | String | Substring match via `LIKE`. | `{"title":{"$contains":"SQLite"}}` |
| `$ilike` | LIKE pattern | Case-insensitive pattern; `%` and `_` retain LIKE semantics. | `{"email":{"$ilike":"%@example.com"}}` |
| `$istartsWith` | String | Case-insensitive prefix. | `{"name":{"$istartsWith":"ada"}}` |
| `$iendsWith` | String | Case-insensitive suffix. | `{"filename":{"$iendsWith":".jsonl"}}` |
| `$icontains` | String | Case-insensitive substring. | `{"title":{"$icontains":"database"}}` |
| `$regex` | Regex pattern | Matches via SQLite's registered `REGEXP` function. | `{"code":{"$regex":"^[A-Z]{3}-[0-9]+$"}}` |

#### Type

| Operator | Operand | Definition | Example |
|---|---|---|---|
| `$type` | Type token | Requires the field to have the given JSON type. | `{"profile":{"$type":"object"}}` |

Tokens: `number`, `boolean`, `string`, `array`, `object`, `null`, `integer`, `real`, `text`, `true`, `false`.

#### Complete example

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": {
    "filter": {
      "$and": [
        {"status": {"$in": ["active", "trial"]}},
        {"profile.age": {"$between": [18, 65]}},
        {"roles": {"$any": ["admin", "owner"]}}
      ]
    },
    "sort": "profile.age asc",
    "limit": 2
  }
}
```

```json
{
  "status": "success",
  "data": {
    "count": 2,
    "total_items": 2,
    "items": [
      {"_id": "u1", "status": "active", "profile": {"age": 31}, "roles": ["admin"]},
      {"_id": "u2", "status": "trial", "profile": {"age": 44}, "roles": ["owner"]}
    ],
    "limit": 2,
    "offset": 0,
    "next_offset": null,
    "prev_offset": null,
    "pagination": {
      "total_items": 2, "count": 2, "per_page": 2,
      "page": 1, "total_pages": 1, "next_page": null, "prev_page": null
    }
  }
}
```

---

### Sorting

`sort` accepts an object or a comma-separated string. Dot paths are supported; a missing direction means ascending.

```json
{ "sort": {"profile.age": -1, "name": 1} }
```

```json
{ "sort": "profile.age desc, name asc" }
```

```json
{ "sort": "first_name, last_name" }
```

The last form normalizes to `first_name ASC, last_name ASC`.

| Context | Default sort |
|---|---|
| Document `query` | `_created_at DESC` |
| FTS `query` | `_search_score ASC, _created_at DESC` |
| Lookup candidates | `_created_at DESC` |
| `export_jsonl` | `_created_at DESC` |

---

### Projection

Projection shapes returned documents without modifying stored data. It runs **after** lookups and per-row compute, so projected responses can include or remove lookup aliases and computed fields.

| Property | Behavior |
|---|---|
| `fields` | Start with only the listed paths, then restore `_id`, `_user_id`, and an included `_namespace`. Must not be empty. |
| `exclude_fields` | Remove listed paths from the included or full document. Must not be empty. |
| Both | `fields` is applied first, then `exclude_fields`. |
| Dot paths | Preserve nested object structure rather than flattening keys. |
| Protected | `_id`, `_user_id`, and an included `_namespace` cannot be excluded. |

#### `fields` — inclusion

```json
{ "fields": ["name", "profile.city", "settings.theme"] }
```

Rules:

- `_id` and `_user_id` are added automatically when present, even if absent from `fields`.
- A missing selected path is ignored; it is not returned as `null`.
- Duplicate paths are harmless.
- Selecting an object path returns the complete object. Selecting one nested leaf rebuilds only the structure needed for that leaf.
- An empty `fields: []` is **rejected**. Omit `fields` to return everything.

Given:

```json
{
  "_id": "u1",
  "profile": {
    "city": "London",
    "country": "GB",
    "preferences": {"theme": "light", "density": "compact"}
  }
}
```

`"fields": ["profile"]` returns the whole profile. `"fields": ["profile.city","profile.preferences.theme"]` returns only those leaves while retaining nesting:

```json
{
  "_id": "u1",
  "profile": {"city": "London", "preferences": {"theme": "light"}}
}
```

#### `exclude_fields` — exclusion

```json
{ "exclude_fields": ["password", "security.ssn", "internal.notes"] }
```

Rules:

- Missing exclusion paths are ignored.
- Excluding a parent object removes the entire object.
- Excluding a nested leaf leaves siblings intact.
- `_id` and `_user_id` are restored after exclusion and therefore cannot be removed.
- An empty `exclude_fields: []` is **rejected**.

Given `{"_id":"u1","profile":{"city":"London","country":"GB"},"security":{"ssn":"hidden","mfa":true}}`, excluding `["profile.country","security.ssn"]` returns:

```json
{
  "_id": "u1",
  "profile": {"city": "London"},
  "security": {"mfa": true}
}
```

#### Combining both

```json
{
  "fields": ["name", "profile", "security"],
  "exclude_fields": ["profile.date_of_birth", "security.ssn"]
}
```

`exclude_fields` cannot restore a path omitted by `fields`; it only removes data from the inclusion result.

#### Arrays

Projection dot notation traverses nested **objects**. Arrays are projected as complete values, not element-by-element schemas. Given:

```json
{
  "_id": "order-1",
  "items": [
    {"sku": "A1", "qty": 2, "cost": 10},
    {"sku": "B2", "qty": 1, "cost": 20}
  ]
}
```

`"fields": ["items"]` returns the full array. A path like `items[].sku` does **not** reshape every element. If element-level shaping is required: store the shape directly, use a lookup whose related documents have their own `fields`, or transform the response in the application.

#### System and query-generated fields

| Field | Projection behavior |
|---|---|
| `_id` | Always preserved. |
| `_user_id` | Always preserved when present. |
| `_created_at`, `_modified_at` | Ordinary selectable/excludable paths; exist only when system timestamps are enabled. |
| `_namespace` | Ordinary selectable/excludable path, attached before projection for multi/all-namespace reads. |
| `_search_score` | Ordinary selectable path created by FTS mode. Include it explicitly when using `fields`. |
| Lookup aliases | Available to both, because lookups run first. |
| Computed names | Available to both, because compute runs first. |

FTS projection:

```json
{ "search": "distributed storage", "fields": ["title", "summary", "_search_score"] }
```

```json
{
  "_id": "article-1",
  "title": "Distributed Storage",
  "summary": "A practical overview",
  "_search_score": -2.741
}
```

#### Processing order

1. Retrieve and decorate base documents with configured timestamps and namespace metadata.
2. Overlay pending accepted-write state for exact-ID reads.
3. Run lookups, attaching related documents.
4. Run per-row compute, adding derived fields.
5. Apply `fields` (inclusion).
6. Apply `exclude_fields` (exclusion).
7. Build the separate `data.attachments.users` map using `attach_user_fields`.

Top-level `fields` and `exclude_fields` do **not** project the user attachment map — use `attach_user_fields`.

#### Availability by context

| Context | Supported controls | Notes |
|---|---|---|
| `query` | `fields`, `exclude_fields` | Applies to every returned document. |
| FTS through `query` | `fields`, `exclude_fields` | Include `_search_score` explicitly when using inclusion. |
| `export_jsonl` | `fields`, `exclude_fields` | Shapes every record before JSONL encoding. |
| Individual lookup | `fields` only | `exclude_fields` is not a lookup property. |
| `attach_users` | `attach_user_fields` | Its own attachment-specific projection. |

#### Worked example

Stored document:

```json
{
  "_id": "u1",
  "_user_id": "identity-1",
  "name": "Ada",
  "email": "ada@example.com",
  "profile": {"age": 36, "city": "London"},
  "password": "hidden"
}
```

| Request | Returned item |
|---|---|
| `"fields": ["name","profile.city"]` | `{"_id":"u1","_user_id":"identity-1","name":"Ada","profile":{"city":"London"}}` |
| `"exclude_fields": ["password","profile.age"]` | `{"_id":"u1","_user_id":"identity-1","name":"Ada","email":"ada@example.com","profile":{"city":"London"}}` |
| `"fields": ["name","email","profile"]` + `"exclude_fields": ["email","profile.age"]` | `{"_id":"u1","_user_id":"identity-1","name":"Ada","profile":{"city":"London"}}` |

Projecting lookup and computed fields:

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "orders",
  "payload": {
    "lookups": {
      "customer": {
        "from": "users",
        "local_field": "customer_id",
        "foreign_field": "_id",
        "fields": ["_id", "name"]
      }
    },
    "compute": {"item_count": {"$size": "items[]"}},
    "fields": ["number", "customer", "item_count"]
  }
}
```

```json
{
  "_id": "order-1",
  "number": "INV-1001",
  "customer": {"_id": "u1", "name": "Ada"},
  "item_count": 3
}
```

---

### Lookup operators

Lookups enrich each query result with documents from another namespace **in the same database**. `payload.lookups` is an object map: each key is the response alias, each value is a lookup specification.

- `local_field` always reads from the **current result context**.
- `foreign_field` always reads from **candidate documents** in the `from` namespace.

#### Properties

| Property | Type | Default | Description |
|---|---|---|---|
| `from` | string | **Required** | Namespace containing related documents. |
| `local_field` | string | **Required** | Path resolved from the current, parent, root, or completed-lookup context. Use `[]` to flatten an array. |
| `foreign_field` | string | **Required** | Path on documents in `from`. Use `[]` to flatten a foreign array. |
| `match` | string | `$eq` | `$eq`, `$in`, `$contains`, or `$overlap`. |
| `multi` | bool | `false` | `false` returns the first match or `null`; `true` returns an array. |
| `filter` | object | — | Extra filter operators applied to the foreign namespace **before** relationship matching. Context tokens resolve per current document. |
| `fields` | string[] | All | Inclusion projection applied to each returned foreign document. |
| `sort` | string \| object | `_created_at DESC` | Orders foreign candidates before first-match selection and limiting. |
| `limit` | int | `KOKOADB_QUERY_DEFAULT_LIMIT` | Caps matched documents for this alias. |
| `preserve_order` | bool | `false` | With `$in`, orders results according to the values in `local_field`. |
| `dedupe` | bool | `true` | Removes duplicate related documents by `_id`. |
| `on_missing` | string | `null` | `null` attaches `null`; `empty` attaches `[]` for `multi:true`; `drop` removes the parent result. |
| `strict_path` | bool | `false` | Rejects the query when a referenced context path is missing, instead of treating it as no match. |
| `cache_lookup` | bool | `true` | Reuses identical foreign candidate reads within the current request. |
| `lookups` | object | — | Nested lookup map evaluated against matched foreign documents. |

#### `from` — foreign namespace

Names the namespace holding candidates. Lookups stay inside the database selected by the outer request; **they cannot join across database files**.

```json
{
  "lookups": {
    "customer": {"from": "users", "local_field": "customer_id", "foreign_field": "_id"}
  }
}
```

#### `local_field` — current-side values

Resolves values from the current result context. A plain path is equivalent to `$self.<path>`.

```json
{ "local_field": "customer_id" }
```

Add `[]` to flatten an array for matching:

```json
{ "local_field": "favorite_books[]" }
```

Context prefixes enable nested and dependency-aware paths:

```json
{ "local_field": "$root.tenant_id" }
{ "local_field": "$parent.vendor_id" }
{ "local_field": "$lookup.items[].product_id" }
```

#### `foreign_field` — related-side values

Always evaluated on candidates from `from`. Nested paths use dot notation:

```json
{ "foreign_field": "identity.external_id" }
```

Flatten a foreign array when matching one local value against its members:

```json
{ "foreign_field": "member_ids[]", "match": "$contains" }
```

Candidates missing the foreign path simply do not match. `strict_path` applies to **current-context** paths and dynamic filter tokens, not to every candidate's foreign path.

#### `multi` — response cardinality

`multi: false` returns one object — the first relationship match after lookup sorting — or `null`:

```json
{ "customer": {"_id": "u1", "name": "Ada"} }
```

`multi: true` returns an array, including `[]` when `on_missing: "empty"`:

```json
{
  "books": [
    {"_id": "b1", "title": "SQLite Internals"},
    {"_id": "b2", "title": "Rust Services"}
  ]
}
```

Use `multi: false` for one-to-one and many-to-one; `multi: true` for one-to-many and many-to-many.

#### `filter` — restricting foreign candidates

Applies filter operators only to the `from` namespace, evaluated **before** relationship matching. Static and context-derived values may be combined.

```json
{
  "lookups": {
    "current_membership": {
      "from": "memberships",
      "local_field": "_id",
      "foreign_field": "user_id",
      "multi": false,
      "filter": {
        "tenant_id": "$root.tenant_id",
        "status": {"$eq": "active"}
      }
    }
  }
}
```

```json
{
  "_id": "u1",
  "tenant_id": "tenant-a",
  "current_membership": {
    "_id": "membership-1",
    "user_id": "u1",
    "tenant_id": "tenant-a",
    "status": "active"
  }
}
```

Any string filter value beginning with `$root.`, `$parent.`, `$self.`, or `$lookup.` is resolved from that context before the foreign query runs.

#### `fields` — lookup-level projection

Applies inclusion projection to each matched foreign document before attaching it. `_id` remains protected. Lookup candidate loading does **not** attach the document table's external `_user_id` column to related documents.

```json
{
  "lookups": {
    "customer": {
      "from": "users",
      "local_field": "customer_id",
      "foreign_field": "_id",
      "fields": ["_id", "name", "profile.avatar"]
    }
  }
}
```

Lookup specifications do not support `exclude_fields` — use an explicit `fields` allowlist.

> **Lookup projection runs before nested lookups.** Include every field needed by nested `local_field` paths, or the nested lookup has nothing to match on:
>
> ```json
> {
>   "fields": ["_id", "name", "vendor_id"],
>   "lookups": {
>     "vendor": {"from": "vendors", "local_field": "vendor_id", "foreign_field": "_id"}
>   }
> }
> ```
>
> Omitting `vendor_id` here would leave the nested vendor lookup without its local value.

#### `sort` and `limit` — choosing related results

`sort` orders foreign candidates before `multi: false` picks its first match and before `limit` truncates a multi-result.

```json
{
  "lookups": {
    "latest_logins": {
      "from": "login_events",
      "local_field": "_id",
      "foreign_field": "user_id",
      "multi": true,
      "sort": "created_at desc",
      "limit": 3
    }
  }
}
```

> Keep lookup limits bounded: the cap applies **per root document, per lookup alias**. A page of 50 roots with `limit: 100` is 5,000 related documents.

#### `preserve_order` and `dedupe`

`preserve_order: true` is meaningful for `$in`: it reorders matched foreign documents according to the flattened local values. Useful for ordered id lists such as favorites, playlists, or manually ranked content.

`dedupe: true` (default) removes duplicate matches by `_id`. Set `false` only when repeated rows are intentionally meaningful. Documents without `_id` cannot be de-duplicated this way.

```json
{
  "local_field": "playlist_track_ids[]",
  "foreign_field": "_id",
  "match": "$in",
  "multi": true,
  "preserve_order": true,
  "dedupe": true
}
```

#### `on_missing` — no-match behavior

Applies when the local path resolves no values or no foreign document matches.

| Value | `multi: false` | `multi: true` | Parent result |
|---|---|---|---|
| `null` | Alias is `null` | Alias is `null` | Kept |
| `empty` | Alias is `null` | Alias is `[]` | Kept |
| `drop` | Not returned | Not returned | **Removed** from query items |

> `on_missing: "drop"` behaves like a required relationship. It removes root documents **after** lookup processing, so `data.count` for the page can be lower than expected while `data.total_items` still reflects the base query.

#### `strict_path` — missing context validation

With the default `false`, a missing local/context path produces no values and follows `on_missing`. With `true`, a missing `local_field` or a missing context token used by lookup `filter` **rejects the request**.

```json
{ "local_field": "$root.required_customer_id", "strict_path": true }
```

Use strict paths when a missing relationship key indicates malformed data. Keep the default for optional relationships.

#### `cache_lookup` — request-local reuse

With the default `true`, identical candidate reads inside one query request are reused. The cache key includes the foreign namespace, foreign path, match mode, resolved local values, resolved filter, and sort definition.

This cache:

- exists only for the current request;
- is separate from `payload.cache`, which caches complete read responses;
- does not persist across requests or instances;
- helps most when many root rows resolve the same relationship values.

Set `false` when each lookup execution must independently read candidates.

#### Lookup match operators

| Operator | Typical direction | Meaning | Example paths |
|---|---|---|---|
| `$eq` | Scalar → scalar | Current value equals foreign value. | `customer_id` → `_id` |
| `$in` | Current array → foreign scalar | Foreign value occurs in the current values. | `favorite_books[]` → `_id` |
| `$contains` | Current scalar → foreign array | Foreign array contains the current value. | `skill_id` → `skill_ids[]` |
| `$overlap` | Current array → foreign array | At least one flattened value exists on both sides. | `tag_ids[]` → `tag_ids[]` |

The names communicate relationship direction. Internally, the selected local and foreign paths are flattened as requested and compared for intersecting values.

#### Path contexts

| Prefix | Resolves from | Typical use |
|---|---|---|
| none or `$self.` | Current document at this lookup level | Join a row to its direct related data. |
| `$parent.` | Document that produced the current nested lookup row | Use an outer matched document inside a nested lookup. |
| `$root.` | Original root query document | Refer back to the root from any depth. |
| `$lookup.<alias>.` | A completed lookup alias in the same scope | Build a lookup from another lookup's result, including forward references. |

Array traversal uses `[]`, e.g. `$lookup.items[].product_id`. Sibling aliases that do not depend on each other run **concurrently**. References create a dependency graph; Kokoadb topologically schedules them, permits forward references, and rejects unknown aliases or cycles.

#### Nested lookups

Nested `lookups` run against each document matched by the containing lookup. Each nested alias attaches to that **related** document, not to the root item.

```json
{
  "lookups": {
    "items": {
      "from": "order_items",
      "local_field": "_id",
      "foreign_field": "order_id",
      "multi": true,
      "lookups": {
        "product": {
          "from": "products",
          "local_field": "product_id",
          "foreign_field": "_id",
          "multi": false,
          "lookups": {
            "vendor": {
              "from": "vendors",
              "local_field": "vendor_id",
              "foreign_field": "_id",
              "multi": false,
              "fields": ["_id", "name"]
            }
          }
        }
      }
    }
  }
}
```

```json
{
  "_id": "order-1",
  "items": [
    {
      "_id": "line-1",
      "order_id": "order-1",
      "product_id": "product-9",
      "product": {
        "_id": "product-9",
        "vendor_id": "vendor-7",
        "vendor": {"_id": "vendor-7", "name": "Systems House"}
      }
    }
  ]
}
```

#### Lookup depth

Depth counts **nested lookup scopes**, not aliases or dependency edges.

| Depth | Example above |
|---|---|
| 1 | Root alias `items` |
| 2 | Nested alias `items.product` |
| 3 | Nested alias `items.product.vendor` |

The default `KOKOADB_QUERY_LOOKUP_MAX_DEPTH=3` allows exactly that example. A fourth nested scope is rejected by default.

Independent sibling aliases stay at the same depth. A forward dependency such as `vendors` reading `$lookup.books[]` also stays at the same depth — it changes execution order, not structural nesting.

To request a different maximum for one query:

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "orders",
  "payload": {
    "lookup_depth_override": 5,
    "lookups": {
      "level_1": {
        "from": "one", "local_field": "one_id", "foreign_field": "_id",
        "lookups": {
          "level_2": {"from": "two", "local_field": "two_id", "foreign_field": "_id"}
        }
      }
    }
  }
}
```

Override rules:

- Must be a positive integer.
- When `KOKOADB_QUERY_LOOKUP_UNCAPPED_OVERRIDE_ENABLED=false`, the request may **lower** the effective depth but not exceed `KOKOADB_QUERY_LOOKUP_MAX_DEPTH`.
- When `true`, the request may set a higher finite depth.
- The request remains subject to `KOKOADB_OPERATION_TIMEOUT_MS`, lookup limits, and bounded lookup concurrency.
- Cycles and unknown `$lookup.<alias>` references are rejected regardless of depth settings.

### Relationship patterns

#### One-to-one with `$eq`

Orders contain `customer_id`; users expose `_id`.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "orders",
  "payload": {
    "lookups": {
      "customer": {
        "from": "users",
        "local_field": "customer_id",
        "foreign_field": "_id",
        "match": "$eq",
        "multi": false,
        "fields": ["_id", "name", "email"]
      }
    }
  }
}
```

```json
{
  "_id": "order-1",
  "customer_id": "u1",
  "total": 125,
  "customer": {"_id": "u1", "name": "Ada", "email": "ada@example.com"}
}
```

#### One-to-many with `$in` and preserved order

A user stores book ids in `favorite_books`. The `[]` suffix flattens that local array.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": {
    "lookups": {
      "books": {
        "from": "books",
        "local_field": "favorite_books[]",
        "foreign_field": "_id",
        "match": "$in",
        "multi": true,
        "preserve_order": true,
        "dedupe": true,
        "fields": ["_id", "title"]
      }
    }
  }
}
```

```json
{
  "_id": "u1",
  "favorite_books": ["b3", "b1"],
  "books": [
    {"_id": "b3", "title": "Distributed Systems"},
    {"_id": "b1", "title": "SQLite Internals"}
  ]
}
```

#### Foreign array with `$contains`

The current document has one `skill_id`; each team has a `skill_ids` array.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "profiles",
  "payload": {
    "lookups": {
      "matching_teams": {
        "from": "teams",
        "local_field": "skill_id",
        "foreign_field": "skill_ids[]",
        "match": "$contains",
        "multi": true,
        "fields": ["_id", "name", "skill_ids"]
      }
    }
  }
}
```

```json
{
  "_id": "profile-1",
  "skill_id": "rust",
  "matching_teams": [
    {"_id": "team-1", "name": "Platform", "skill_ids": ["rust", "sql"]},
    {"_id": "team-3", "name": "Storage", "skill_ids": ["rust", "s3"]}
  ]
}
```

#### Array-to-array with `$overlap`

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "articles",
  "payload": {
    "lookups": {
      "related": {
        "from": "articles",
        "local_field": "tag_ids[]",
        "foreign_field": "tag_ids[]",
        "match": "$overlap",
        "multi": true,
        "filter": {"status": "published"},
        "fields": ["_id", "title", "tag_ids"],
        "limit": 3
      }
    }
  }
}
```

An explicit lookup `filter` is the way to remove the current document from a self-lookup, when the application has a suitable distinguishing field.

#### Nested lookup with root and parent context

Resolve order items, then each item's product, requiring the product tenant to equal the root order's tenant.

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "orders",
  "payload": {
    "lookups": {
      "items": {
        "from": "order_items",
        "local_field": "_id",
        "foreign_field": "order_id",
        "match": "$eq",
        "multi": true,
        "lookups": {
          "product": {
            "from": "products",
            "local_field": "$self.product_id",
            "foreign_field": "_id",
            "match": "$eq",
            "filter": {
              "tenant_id": "$root.tenant_id",
              "vendor_id": "$parent.vendor_id"
            },
            "fields": ["_id", "name", "vendor_id"]
          }
        }
      }
    }
  }
}
```

At this nested level `$self` is the order item, `$parent` is the root order that produced the items lookup, and `$root` is also the original order. At deeper levels `$parent` and `$root` differ.

#### Forward dependency

Alias order in the request does not control execution. Here `vendors` appears first but waits for `books`, because its local path references `$lookup.books`.

```json
{
  "lookups": {
    "vendors": {
      "from": "vendors",
      "local_field": "$lookup.books[].vendor_id",
      "foreign_field": "_id",
      "match": "$in",
      "multi": true,
      "fields": ["_id", "name"]
    },
    "books": {
      "from": "books",
      "local_field": "favorite_books[]",
      "foreign_field": "_id",
      "match": "$in",
      "multi": true,
      "fields": ["_id", "title", "vendor_id"]
    }
  }
}
```

```json
{
  "_id": "u1",
  "favorite_books": ["b1", "b2"],
  "books": [
    {"_id": "b1", "title": "SQLite Internals", "vendor_id": "v1"},
    {"_id": "b2", "title": "Rust Services", "vendor_id": "v2"}
  ],
  "vendors": [
    {"_id": "v1", "name": "Northwind Press"},
    {"_id": "v2", "name": "Systems House"}
  ]
}
```

---

### Compute operators

Compute operators have two execution modes:

- **`aggregate`** applies them across all documents selected by the operation filter and returns one result object.
- **`query`** applies them independently to array/object/string values in each fetched document, adding named values to that item **before projection**.

Each compute definition must contain exactly one primary operator. `$distinct: true` and `$filter: {...}` are modifiers, not additional primary operators.

| Operator | Aggregate behavior | Per-row `query` behavior | Example |
|---|---|---|---|
| `$count` | Counts rows with `"*"` or non-null field values. | Counts values extracted from an array path. | `"total":{"$count":"*"}` |
| `$sum` | Sums a numeric field across matching rows. | Sums numeric values in an array path. | `"revenue":{"$sum":"amount"}` |
| `$avg` | Averages a numeric field across rows. | Averages numeric values in an array path. | `"average":{"$avg":"scores[]"}` |
| `$min` | Minimum numeric field value. | Minimum numeric array value. | `"minimum":{"$min":"scores[]"}` |
| `$max` | Maximum numeric field value. | Maximum numeric array value. | `"maximum":{"$max":"scores[]"}` |
| `$distinct` | Unique values from a field or flattened `[]` path. | Unique values from an array path. | `"countries":{"$distinct":"country"}` |
| `$size` | **Not supported** | Array length, object key count, string character count, or `null`. | `"item_count":{"$size":"items"}` |
| `$join` | **Not supported** | Concatenates literals and `$field.path` references into a string. | `"full_name":{"$join":["$first_name"," ","$last_name"]}` |

#### Modifiers

| Modifier | Definition | Example |
|---|---|---|
| `$distinct: true` | De-duplicates values before `$count`, `$sum`, or `$avg`. | `{"$count":"country","$distinct":true}` |
| `$filter: {...}` | Metric-local filter. `aggregate` accepts the full filter operator set. Per-row array filtering accepts `$and`, `$or`, direct equality, `$eq`, `$ne`, `$in`, `$nin`. | `{"$count":"events[]","$filter":{"status":"ok"}}` |

#### Aggregate example

```json
{
  "db": "myapp/main",
  "operation": "aggregate",
  "namespace": "orders",
  "payload": {
    "filter": {"status": "paid"},
    "compute": {
      "orders": {"$count": "*"},
      "revenue": {"$sum": "amount"},
      "average_order": {"$avg": "amount"},
      "customers": {"$count": "customer_id", "$distinct": true},
      "countries": {"$distinct": "shipping.country"}
    }
  }
}
```

#### Per-row example

```json
{
  "db": "myapp/main",
  "operation": "query",
  "namespace": "users",
  "payload": {
    "compute": {
      "full_name": {"$join": ["$first_name", " ", "$last_name"]},
      "score_total": {"$sum": "scores[]"},
      "score_average": {"$avg": "scores[]"},
      "tag_count": {"$size": "tags"},
      "unique_tags": {"$distinct": "tags[]"}
    },
    "fields": ["first_name", "last_name", "full_name", "score_total", "score_average", "tag_count", "unique_tags"]
  }
}
```

```json
{
  "_id": "u1",
  "first_name": "Ada",
  "last_name": "Lovelace",
  "full_name": "Ada Lovelace",
  "score_total": 270,
  "score_average": 90,
  "tag_count": 3,
  "unique_tags": ["math", "systems"]
}
```

---

### Generator operators

Generator operators are exact single-key `@` directive objects embedded anywhere in `data`, `insert_data`, or `update_data`. Recognized directives are resolved immediately before persistence.

> Unknown `@` keys, and objects with additional sibling keys, remain ordinary document data. A **recognized** directive with an invalid operand or unknown option is rejected rather than stored.

| Operator | Operand | Produces | Example |
|---|---|---|---|
| `@now` | `true`, scalar, or options object | Current UTC RFC3339 datetime, optionally shifted and formatted. | `{"@now":{"days":1,"format":"%Y-%m-%d"}}` |
| `@timestamp` | `true`, scalar, or shift object | Current Unix epoch **milliseconds** after optional shifts. No formatting. | `{"@timestamp":{"seconds":-30}}` |
| `@uuidv4` | `true` or options object | Random UUIDv4. | `{"@uuidv4":{"prefix":"session:","dash":false}}` |
| `@uuidv7` | `true` or options object | Time-ordered UUIDv7. | `{"@uuidv7":{"prefix":"evt_"}}` |
| `@randomid` | `true` or options object | Secure random identifier. | `{"@randomid":{"len":8,"alphabet":"base62","prefix":"tmp_"}}` |
| `@hash` | Options object | SHA-256 hash of a required string `value`. | `{"@hash":{"value":"Ada","len":12}}` |

Each occurrence is evaluated independently, including inside array items and nested objects. Prefixes and suffixes appear in the returned string but do **not** count toward `len`.

#### `@now`

`@now: true` returns the current UTC datetime using the default `%Y-%m-%dT%H:%M:%SZ` format. Shifts apply before formatting.

| Option | Type | Default | Behavior |
|---|---|---|---|
| `days` | signed int | `0` | Adds or subtracts fixed 24-hour periods. |
| `hours` | signed int | `0` | Adds or subtracts hours. |
| `minutes` | signed int | `0` | Adds or subtracts minutes. |
| `seconds` | signed int | `0` | Adds or subtracts seconds. |
| `format` | non-empty string | `%Y-%m-%dT%H:%M:%SZ` | Chrono/strftime formatting of the shifted UTC datetime. |

```json
{
  "current": {"@now": true},
  "two_hours_from_now": {"@now": {"hours": 2}},
  "yesterday": {"@now": {"days": -1, "format": "%F"}},
  "retention_deadline": {"@now": {"days": 30, "hours": 6, "format": "%Y-%m-%dT%H:%M:%SZ"}}
}
```

> **Month and year shifts are intentionally unsupported** because they have variable lengths. Calculate calendar-relative dates in the application when month-end, leap-year, locale, or user-timezone behavior matters.

Common format tokens:

| Token | Example | Meaning |
|---|---|---|
| `%Y` / `%y` | `2026` / `26` | Four- and two-digit year. |
| `%q` | `3` | Quarter, `1`–`4`. |
| `%m` / `%b` / `%B` | `08` / `Aug` / `August` | Month number, abbreviated name, full name. |
| `%d` | `31` | Zero-padded day of month. |
| `%j` | `243` | Day of year, `001`–`366`. |
| `%a` / `%A` | `Mon` / `Monday` | Abbreviated and full weekday name. |
| `%u` | `1` | ISO weekday, Monday = 1. |
| `%V` | `36` | ISO week number, `01`–`53`. |
| `%F` | `2026-08-31` | ISO date; same as `%Y-%m-%d`. |
| `%H` / `%I` | `17` / `05` | 24-hour and 12-hour clock hour. |
| `%M` / `%S` | `44` / `56` | Zero-padded minute and second. |
| `%p` | `PM` | Uppercase AM/PM. |
| `%R` / `%T` | `17:44` / `17:44:56` | `%H:%M` and `%H:%M:%S`. |
| `%.3f` | `.275` | Millisecond fraction including the decimal point. |
| `%z` / `%:z` | `+0000` / `+00:00` | UTC offset. `@now` always evaluates in UTC. |
| `%+` | `2026-08-31T17:44:56.275+00:00` | ISO 8601 / RFC3339. |
| `%s` | `1788198296` | Unix seconds, as a string. |
| `%%` | `%` | Literal percent. |

```json
{
  "year": {"@now": {"format": "%Y"}},
  "date": {"@now": {"format": "%F"}},
  "time": {"@now": {"format": "%T"}},
  "with_milliseconds": {"@now": {"format": "%Y-%m-%dT%H:%M:%S%.3fZ"}},
  "week_key": {"@now": {"format": "%Y-W%V"}}
}
```

#### `@timestamp`

Returns the current Unix timestamp in **milliseconds** as a JSON integer. Accepts the same signed `days`, `hours`, `minutes`, `seconds` shifts as `@now`. It does not accept `format` — use `@now` for a formatted string.

```json
{
  "created_ms": {"@timestamp": true},
  "expires_ms": {"@timestamp": {"minutes": 15}},
  "five_seconds_ago_ms": {"@timestamp": {"seconds": -5}}
}
```

#### `@uuidv4` and `@uuidv7`

`@uuidv4` is random. `@uuidv7` embeds time ordering and is preferable when lexicographically sortable identifiers improve index locality. Both accept the same options.

| Option | Type | Default | Behavior |
|---|---|---|---|
| `prefix` | string | `""` | Text prepended. |
| `suffix` | string | `""` | Text appended. |
| `dash` | bool | `false` | `true` uses the standard dashed representation; otherwise 32 hex characters. |

```json
{
  "random_uuid": {"@uuidv4": true},
  "ordered_uuid": {"@uuidv7": true},
  "session_id": {"@uuidv4": {"prefix": "session_", "suffix": "_primary", "dash": false}}
}
```

#### `@randomid`

Produces an unbiased secure random string. `len` controls only the generated portion.

| Option | Type | Default | Behavior |
|---|---|---|---|
| `len` | int `1`–`128` | `12` | Number of generated characters. |
| `alphabet` | string | `hex` | Allowed character set. |
| `prefix` / `suffix` | string | `""` | Text around the generated characters. |

| Alphabet | Character set | Size | Typical use |
|---|---|---|---|
| `hex` | `0123456789abcdef` | 16 | Lowercase hex ids; hex-only systems. |
| `numeric` | `0123456789` | 10 | Numeric reference codes. Leading zeroes are preserved because the result is a string. |
| `base32` | `0123456789ABCDEFGHJKMNPQRSTVWXYZ` | 32 | Crockford-style ids omitting ambiguous `I`, `L`, `O`, `U`. |
| `base62` | `0-9A-Za-z` | 62 | Most compact case-sensitive URL-safe ids. |

```json
{
  "default_hex": {"@randomid": true},
  "pin": {"@randomid": {"len": 6, "alphabet": "numeric"}},
  "readable_code": {"@randomid": {"len": 10, "alphabet": "base32"}},
  "public_id": {"@randomid": {"len": 20, "alphabet": "base62", "prefix": "pub_"}}
}
```

#### `@hash`

Deterministically hashes one string and returns lowercase hexadecimal.

| Option | Type | Default | Behavior |
|---|---|---|---|
| `value` | string | **Required** | Input string. |
| `algo` | string | `sha256` | Only `sha256` is currently accepted. |
| `len` | int `1`–`64` | `64` | Truncates the digest before prefix/suffix. |
| `prefix` / `suffix` | string | `""` | Text around the digest. |

```json
{
  "full_hash": {"@hash": {"value": "Ada"}},
  "short_hash": {"@hash": {"value": "Ada", "len": 16, "prefix": "sha256_"}}
}
```

> `@hash` is **not** password hashing, encryption, or HMAC signing. Passwords, authentication tokens, and keyed signatures must be processed by the application with an appropriate security-specific mechanism.

#### Complete write

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "sessions",
  "payload": {
    "data": {
      "_id": {"@uuidv4": {"prefix": "session:"}},
      "event_id": {"@uuidv7": true},
      "short_code": {"@randomid": {"len": 8, "alphabet": "base62", "prefix": "code_"}},
      "created_at": {"@now": true},
      "expires_at": {"@now": {"hours": 2}},
      "date_key": {"@now": {"format": "%Y-%m-%d"}},
      "created_ms": {"@timestamp": true},
      "email_hash": {"@hash": {"value": "ada@example.com", "len": 16}}
    }
  }
}
```

```json
{
  "_id": "session:550e8400e29b41d4a716446655440000",
  "event_id": "0198fc3d47b77a90b37cc77f7d7d40c1",
  "short_code": "code_9f31a72c",
  "created_at": "2026-08-07T15:00:00Z",
  "expires_at": "2026-08-07T17:00:00Z",
  "created_ms": 1786114800000,
  "email_hash": "b5fc85e55755f9e0"
}
```

Generated values vary per execution; the concrete values above illustrate output shape only.

---

### Mutation operators

Mutation operators are for `update`. They operate on the current stored document and support dot-path keys such as `profile.login_count`. Each operator object must be the **complete value** assigned to that path.

| Operator | Operand | Behavior | Example |
|---|---|---|---|
| `$replace` | Object | Replaces the complete object at the path instead of patching it. Works at the root or any nested path. | `"claims":{"$replace":{"roles":["new-role"]}}` |
| `$unset` | `true` | Removes the field completely. | `"profile.legacy":{"$unset":true}` |
| `$inc` | `true` or signed number | Adds the operand; `true` means `1`. Missing or null fields start at the delta. | `"score":{"$inc":-2}` |
| `$push` | Any value | Appends one value to an array. Missing or null fields become arrays. | `"events":{"$push":{"type":"login"}}` |
| `$pop` | `true`, `1`, or `-1` | Removes the last item for `true`/`1`, the first for `-1`. | `"queue":{"$pop":-1}` |
| `$extend` | Array | Appends all operand items to the target array. | `"tags":{"$extend":["paid","beta"]}` |
| `$pull` | Value or array | Removes every item equal to any operand value. | `"tags":{"$pull":["old","blocked"]}` |
| `$addset` | Value or array | Appends only values not already present, by JSON equality. | `"roles":{"$addset":"editor"}` |
| `$rename` | Non-empty target path | Moves the source field to the target dot path, removes the source, overwrites an existing destination. A missing source is a no-op. | `"profile.legacy_name":{"$rename":"profile.display_name"}` |

`$rename` cannot target `_id`, `_created_at`, or `_modified_at`, and cannot move a field beneath itself.

#### Worked example

Given:

```json
{
  "_id": "u1",
  "score": 10,
  "tags": ["new", "beta"],
  "events": [],
  "profile": {"legacy": true, "old_label": "Primary"}
}
```

Request:

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "users",
  "payload": {
    "data": {
      "_id": "u1",
      "score": {"$inc": 5},
      "tags": {"$addset": ["beta", "paid"]},
      "events": {"$push": {"type": "login"}},
      "profile.legacy": {"$unset": true},
      "profile.old_label": {"$rename": "profile.label"}
    }
  }
}
```

Result:

```json
{
  "_id": "u1",
  "score": 15,
  "tags": ["new", "beta", "paid"],
  "events": [{"type": "login"}],
  "profile": {"label": "Primary"}
}
```

#### Strictness

Controlled by `KOKOADB_STRICT_MUTATIONS_OPERATORS`:

| Value | Behavior |
|---|---|
| `false` (default) | An unknown operator, most invalid operands, or an incompatible existing field type leaves that field unchanged rather than failing the whole update. Array operators initialize missing and null targets as arrays. An unrecognized `$pop` operand normalizes to an end-pop. |
| `true` | Unknown operators, invalid operands, and incompatible target types reject the request. |

Permissive mode is forgiving during migrations; strict mode is better once your write paths are stable.

---

### Positional array updates

Use named positional selectors when an update should affect only array elements matching a condition. The syntax is `$[name]` in the mutation path, with the condition supplied in `payload.array_filters`.

```json
{
  "db": "commerce/main",
  "operation": "update",
  "namespace": "orders",
  "payload": {
    "data": {
      "shipments.$[shipment].items.$[item].qty": {"$inc": 1},
      "shipments.$[shipment].items.$[item].tags": {"$addset": "reviewed"}
    },
    "array_filters": {
      "shipment": {
        "status": {"$in": ["processing", "queued"]},
        "warehouse.region": "us-east"
      },
      "item": {
        "$and": [
          {"qty": {"$gte": 2, "$lt": 10}},
          {"sku": {"$in": ["A1", "B2"]}},
          {"tags": {"$includes": "priority"}}
        ]
      }
    }
  }
}
```

Rules:

- Selectors may be nested at multiple array levels.
- A filter is evaluated against each candidate array element; **all** matching elements are updated.
- Named selectors may be reused across multiple mutation paths.
- Every selector used in `data` must have exactly one non-empty object in `array_filters`. Unused filter entries are **rejected**.
- Positional selectors must follow an array field and precede a target field.
- Missing arrays match nothing.
- A non-array target is ignored in permissive mutation mode and rejected when `KOKOADB_STRICT_MUTATIONS_OPERATORS=true`.

Available in direct `update`, bulk/filter updates, data-array updates, `upsert` updates, transactions, and accepted-write preparation.

---

### Document lifecycle transitions

Lifecycle transitions are durable, named, **one-time conditional mutations**. Use them when a document should change later only if its state still satisfies a condition — expiring an unaccepted invitation, timing out an unfinished job, publishing content, assigning a TTL after a status change.

Compare with TTL:

- TTL archives or deletes a document when `_expires_at` is reached.
- A transition evaluates current document state at `execute_at` and **conditionally** updates fields.
- A transition may set `ttl_seconds` and `expiry_behavior`, delegating later expiration back to TTL.

#### Shape

`payload.lifecycle` accepts one object or a non-empty array. Every item requires a unique `name`, exactly one time selector, a `when` filter object, and a non-empty `update` object.

| Property | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Stable name scoped to the document. Scheduling the same document + name **replaces** that transition; different names coexist. |
| `at` | string | One time selector | Absolute RFC3339 datetime, normalized to UTC. Mutually exclusive with `after_seconds`. |
| `after_seconds` | int | One time selector | Positive delay. The clock starts when the scheduling write **commits**, including accepted writes. |
| `when` | object | Yes | Filter operators evaluated against the current document inside the serialized execution transaction. `{}` means always apply while the document exists. |
| `update` | object | Yes | JSON merge patch or mutation operators. `_id` cannot be changed. Generator operators resolve at **execution** time, not scheduling time. `array_filters` enables named positional paths. |
| `ttl_seconds` | int | No | `1+` assigns a TTL from execution time; `0` clears the existing TTL. |
| `expiry_behavior` | string | No | `archive` or `delete`, applied with the transition. |

#### Attach to an insert

A singular insert can create the document and its transitions in the same SQLite transaction. Bulk `data: [...]` with lifecycle is rejected.

```json
{
  "db": "myapp/main",
  "operation": "insert",
  "namespace": "invitations",
  "payload": {
    "commit": true,
    "data": {"email": "user@example.com", "status": "pending"},
    "lifecycle": {
      "name": "expire_invitation",
      "after_seconds": 86400,
      "when": {
        "accepted_at": {"$exists": false},
        "status": "pending"
      },
      "update": {
        "status": "expired",
        "expired_at": {"@now": true}
      }
    }
  }
}
```

#### Attach multiple transitions to an update

An explicit-ID update may atomically alter a document and schedule several independent transitions. Filter updates and update arrays cannot carry lifecycle definitions.

```json
{
  "db": "myapp/main",
  "operation": "update",
  "namespace": "content",
  "payload": {
    "data": {"_id": "article_1", "status": "scheduled"},
    "lifecycle": [
      {
        "name": "publish",
        "at": "2026-08-10T14:00:00Z",
        "when": {"status": "scheduled"},
        "update": {"status": "published", "published_at": {"@now": true}}
      },
      {
        "name": "expire",
        "at": "2026-09-10T14:00:00Z",
        "when": {"status": "published"},
        "update": {"status": "expired"},
        "ttl_seconds": 604800,
        "expiry_behavior": "archive"
      }
    ]
  }
}
```

`upsert` also accepts lifecycle when `max_docs` is exactly `1` — the transition attaches to the one updated or inserted document. `max_docs` of `0`, `-1`, or greater than one is rejected when lifecycle is present.

Inside `transaction`, supported singular `insert`, explicit-ID `update`, and `upsert` with `max_docs: 1` may also carry lifecycle; their document mutation and transition rows commit or roll back together.

Committed write responses include scheduling metadata:

```json
{
  "status": "success",
  "data": {
    "items": [{"_id": "article_1", "status": "scheduled"}],
    "count": 1,
    "lifecycle": {"count": 2, "transition_ids": ["9f...", "42..."]}
  },
  "committed": true,
  "is_async_ack": false
}
```

> Accepted writes return prepared document acknowledgement data but **do not promise transition ids** before the queued write commits. Use `list_transitions` with the document id, or use committed mode when you need the ids immediately.

#### `schedule_transition`

Creates or replaces one named transition without otherwise modifying the document. `document_id` or `id` is required. Namespace is optional because document ids are global; when supplied it is a strict ownership check.

```json
{
  "db": "myapp/main",
  "operation": "schedule_transition",
  "namespace": "orders",
  "payload": {
    "document_id": "order_1",
    "name": "cancel_unpaid",
    "after_seconds": 1800,
    "when": {"payment.status": {"$ne": "paid"}},
    "update": {
      "status": "cancelled",
      "cancelled_at": {"@now": true},
      "events": {"$push": {"type": "payment_timeout"}}
    }
  }
}
```

#### `get_transition` and `list_transitions`

Select one transition with `transition_id`, or with `document_id` plus `name`:

```json
{
  "db": "myapp/main",
  "operation": "get_transition",
  "payload": {"document_id": "order_1", "name": "cancel_unpaid"}
}
```

`list_transitions` supports `document_id`, `namespace`, `name`, `status`, `execute_at_from`, `execute_at_to`, and standard pagination:

```json
{
  "db": "myapp/main",
  "operation": "list_transitions",
  "payload": {
    "status": "failed",
    "execute_at_from": "2026-08-01T00:00:00Z",
    "execute_at_to": "2026-09-01T00:00:00Z",
    "page": 1,
    "per_page": 50
  }
}
```

Transition items expose `transition_id`, `document_id`, `namespace`, `name`, `execute_at`, `when`, `update`, TTL options, `status`, `attempts`, error/skip diagnostics, and timestamps.

#### `cancel_transition` and `retry_transition`

Cancellation only changes a `pending` transition, retaining it as `cancelled` history:

```json
{
  "db": "myapp/main",
  "operation": "cancel_transition",
  "payload": {"transition_id": "transition_1"}
}
```

Execution failures remain `failed`; **there is no automatic retry.** Explicit retry moves only a failed transition back to `pending`. Omit the time selector to retry immediately, or provide a new `at` or positive `after_seconds`:

```json
{
  "db": "myapp/main",
  "operation": "retry_transition",
  "payload": {"transition_id": "transition_1", "after_seconds": 60}
}
```

#### Statuses

| Status | Meaning |
|---|---|
| `pending` | Waiting for `execute_at`. |
| `running` | Claimed inside the serialized database transaction. |
| `completed` | Condition matched and the update committed. |
| `skipped` | Document was missing or `when` no longer matched; see `skipped_reason`. |
| `failed` | Evaluation or update failed; inspect `last_error` and retry explicitly if appropriate. |
| `cancelled` | Pending execution was intentionally disabled. |

#### Execution rules

- The background reaper runs a bounded lifecycle pass for active databases, selecting at most **100 due rows per database pass** and submitting execution through the per-database committed write coordinator.
- `reap_db` runs both TTL maintenance and due lifecycle transitions immediately.
- Soft delete and TTL archive **cancel** pending transitions.
- Hard delete and archive purge **permanently remove** transition rows.
- Restoring an archived document does **not** reactivate cancelled transitions.
- `change_namespace` and `rename_namespace` update the stored transition namespace.
- Replacing a document preserves existing transitions unless `payload.lifecycle` replaces the same document + name.

---

### Import and export

#### `import_jsonl`

Creates a background job that streams newline-delimited JSON into one namespace in bounded batches. Use it instead of `insert` for large files, resumable ingestion, S3 sources, or migrations needing conflict and field-cleanup policies.

The gateway records the job and returns immediately. Background workers claim it through `__kdb_jobs`, persist progress after each batch, and allow another worker to continue a resumable failed job from its recorded line/byte offset.

**Requirements**

- One concrete top-level `namespace`, which may be created by the import.
- `source_path` is required.
- Every decompressed line must be one valid UTF-8 JSON object.
- Supported sources: local `.jsonl`, local `.jsonl.zst`, `s3://….jsonl`, `s3://….jsonl.zst`.

**Options**

| Property | Type | Default | Description |
|---|---|---|---|
| `source_path` | string | **Required** | Local path or `s3://bucket/key`. Compression detected from `.zst`. |
| `source_hash` | string | S3 metadata when present | Caller-provided source identity for duplicate-job detection. For S3, also validated against `x-amz-meta-source-hash`; local imports treat it as a caller-supplied identity. |
| `on_conflict` | string | `error` | `_id` conflict policy: `error`, `skip`, `replace`, or `merge`. |
| `ignore_input_id` | bool | `false` | Removes incoming `_id` and `id`, then generates a new `_id`. `_key` remains ordinary data. |
| `drop_keys` | string[] | `[]` | Removes named top-level or dot-path fields before persistence. `_id` cannot be dropped this way. |
| `allow_system_timestamps` | bool | `false` | Accepts imported `_created_at` / `_modified_at`. If only `_created_at` exists, it is also used as `_modified_at`. |
| `batch_size` | int | `500` | Documents per committed batch, clamped to `1..10000`. |
| `resumable` | bool | `false` | Allows a failed job to be reopened with `continue_job`. |

If a source hash matches an equivalent active or completed import for the same namespace **and** the same import options, Kokoadb returns the existing job with `deduped: true` instead of enqueuing a duplicate.

#### Import a local file

```json
{
  "db": "myapp/main",
  "operation": "import_jsonl",
  "namespace": "users",
  "payload": {
    "source_path": "/data/imports/users.jsonl",
    "on_conflict": "merge",
    "batch_size": 1000,
    "resumable": true
  }
}
```

#### Import a compressed S3 migration

```json
{
  "db": "myapp/main",
  "operation": "import_jsonl",
  "namespace": "users",
  "payload": {
    "source_path": "s3://migration-bucket/exports/users.jsonl.zst",
    "source_hash": "upload-2026-08-07-users-v3",
    "on_conflict": "replace",
    "ignore_input_id": false,
    "drop_keys": ["legacy.password", "temporary_flag"],
    "allow_system_timestamps": true,
    "batch_size": 2000,
    "resumable": true
  }
}
```

#### Response

```json
{
  "status": "success",
  "data": {
    "job_id": "17ed650141934293b15200810a0d83f3",
    "status": "queued",
    "namespace": "users",
    "source_path": "/data/imports/users.jsonl",
    "on_conflict": "merge",
    "ignore_input_id": false,
    "allow_system_timestamps": false,
    "batch_size": 1000,
    "resumable": true
  }
}
```

Use `get_job` to inspect progress, `continue_job` to reopen a resumable failed import, `abort_job` to make it terminal.

---

#### Browser upload to S3

`create_import_upload_url` creates a short-lived presigned S3 `PUT` request for an import source. Available only when `KOKOADB_STORAGE_MODE=s3`. It is authenticated like every gateway operation and does **not** create, open, or modify the selected database.

The Admin UI uses this to upload a local `.jsonl` or `.jsonl.zst` directly to S3. Kokoadb signs the upload but never proxies or buffers the file, so browser memory and request-size limits do not grow with the import file.

```json
{
  "db": "myapp/main",
  "operation": "create_import_upload_url",
  "payload": {
    "filename": "users.jsonl.zst",
    "content_type": "application/zstd",
    "source_hash": "migration-users-v4",
    "expires_in": 900
  }
}
```

| Property | Type | Default | Description |
|---|---|---|---|
| `filename` | string | **Required** | Plain filename ending in `.jsonl` or `.jsonl.zst`. Paths and unsafe characters are rejected. |
| `content_type` | string | `application/x-ndjson` | Bound into the signed request. Use `application/zstd` for compressed input. |
| `source_hash` | string | empty | Written as `x-amz-meta-source-hash`; pass the same value to `import_jsonl` for deduplication and validation. |
| `expires_in` | int | `900` | URL lifetime in seconds, clamped to `60..3600`. |

```json
{
  "status": "success",
  "data": {
    "upload_url": "https://bucket.s3.amazonaws.com/...signed-query...",
    "source_path": "s3://bucket/data/kokoadb/data/imports/myapp/main/7c.../users.jsonl.zst",
    "filename": "users.jsonl.zst",
    "method": "PUT",
    "required_headers": {
      "content-type": "application/zstd",
      "x-amz-meta-source-hash": "migration-users-v4"
    },
    "expires_in": 900,
    "expires_at": "2026-09-05T14:15:00Z"
  }
}
```

Upload the bytes to `upload_url` with the returned method and **every** `required_headers` entry. After S3 returns success, submit `import_jsonl` with the returned `source_path`.

> **Never send the presigned URL back as `source_path`.** The URL is a temporary bearer credential; `source_path` is the stable object URI.

The bucket must allow browser CORS for the Admin UI origin — at minimum `PUT` plus the `content-type` and `x-amz-meta-source-hash` request headers:

```json
[
  {
    "AllowedOrigins": ["https://kokoa-admin.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-meta-source-hash"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use the exact production Admin UI origin instead of `*`. Kokoadb's S3 credentials need `s3:PutObject` for the configured upload prefix and `s3:GetObject` so the import worker can read the uploaded object.

---

#### `export_jsonl`

Creates a background job that queries documents and writes newline-delimited JSON in bounded parts before finalizing one output object. Use it for data portability, migrations, analytics handoff, offline processing, and large downloads that must not block the gateway.

**Scope and output**

- Select one namespace with a string, several with an array, or all with `namespace: "*"` / `scope: "all"`.
- If `target_path` is omitted, Kokoadb generates a path under the configured export destination.
- A local target writes to local storage; an `s3://bucket/prefix/object` target uses configured S3 credentials.
- `compress: true` produces `.jsonl.zst`; `false` produces `.jsonl`.

**Options**

| Property | Type | Default | Description |
|---|---|---|---|
| `target_path` | string | Generated | Local path or S3 URI. The canonical extension is added when needed. |
| `compress` | bool | `true` | Zstandard-compressed JSONL. |
| `include_system_timestamps` | bool | `true` | Includes `_created_at` / `_modified_at` in each object. |
| `filter` | object | `{}` | Filter applied to the export source. |
| `sort` | string \| object | `_created_at DESC` | Stable export order; dot paths supported. |
| `limit` | int | Unlimited | Maximum documents to export. |
| `offset` | int | `0` | Starting offset. |
| `fields` | string[] | All | Include projection. `_id` retained. |
| `exclude_fields` | string[] | `[]` | Exclude projection. `_id` retained. |
| `include_archive` | bool | `false` | Exports live and archived. |
| `archive_only` | bool | `false` | Exports archived only. Cannot combine with `include_archive: true`. |

`page` and `per_page` are accepted for shape compatibility, but execution uses `limit` and `offset` — use those for deterministic exports.

```json
{
  "db": "myapp/main",
  "operation": "export_jsonl",
  "namespace": "users",
  "payload": {
    "filter": {"status": "active"},
    "sort": "_created_at asc",
    "fields": ["_id", "email", "name"],
    "compress": true,
    "include_system_timestamps": true
  }
}
```

Export archive data to S3:

```json
{
  "db": "myapp/main",
  "operation": "export_jsonl",
  "namespace": "users",
  "payload": {
    "target_path": "s3://exports-bucket/kokoa/users-archive",
    "archive_only": true,
    "sort": "_created_at asc",
    "limit": 1000000,
    "offset": 0,
    "exclude_fields": ["password", "ssn"],
    "compress": true
  }
}
```

```json
{
  "status": "success",
  "data": {
    "job_id": "dd21d1525b4544c4b70916572dcb30ea",
    "status": "queued",
    "target_path": "/data/exports/20260807T120000Z__myapp_main.jsonl.zst",
    "compress": true,
    "include_system_timestamps": true
  }
}
```

---

#### Presigned downloads

`create_download_url` returns a short-lived presigned S3 `GET` URL for a completed artifact **already known to Kokoadb**. It never accepts an arbitrary object path, which keeps the gateway from becoming a general-purpose signer for unrelated bucket objects.

| `type` | Required selector | Resolution rule |
|---|---|---|
| `export` | `job_id` | Must be an existing completed `export_jsonl` job whose final target is on S3. |
| `backup` | `backup_id` | Must exist in `__kdb_backup_catalog` with an S3 artifact path. |
| `snapshot` | `snapshot_id` or `latest: true` | Must exist in the database's current remote manifest. The immutable versioned object is signed. |

```json
{
  "db": "myapp/main",
  "operation": "create_download_url",
  "payload": {"type": "export", "job_id": "17ed650141934293b15200810a0d83f3", "expires_in": 300}
}
```

```json
{
  "db": "myapp/main",
  "operation": "create_download_url",
  "payload": {"type": "backup", "backup_id": "565bcaf177fc49198a534a0c5c95330c"}
}
```

```json
{
  "db": "myapp/main",
  "operation": "create_download_url",
  "payload": {"type": "snapshot", "latest": true}
}
```

`snapshot_id` and `latest: true` are mutually exclusive. `expires_in` defaults to `300` seconds, clamped to `60..3600`.

```json
{
  "status": "success",
  "data": {
    "type": "export",
    "artifact_id": "17ed650141934293b15200810a0d83f3",
    "download_url": "https://bucket.s3.amazonaws.com/...signed-query...",
    "source_path": "s3://bucket/exports/users.jsonl.zst",
    "filename": "users.jsonl.zst",
    "content_type": "application/zstd",
    "size_bytes": 18432000,
    "expires_in": 300,
    "expires_at": "2026-09-05T14:05:00Z"
  }
}
```

Before signing, Kokoadb performs an S3 `HEAD` to confirm the resolved object exists and to return its actual size and stored content type. The URL forces browser download disposition and should be treated as a temporary bearer credential.

> Local exports and backups are **rejected** by this S3-only first version.

---

#### Job control

All background work shares one job system and these four operations.

| Operation | Required | Optional | Purpose |
|---|---|---|---|
| `get_job` | `job_id` | `job_type` | Read one job row. |
| `list_jobs` | — | `job_type`, `status`, `limit`, `offset` | List jobs with filters. |
| `continue_job` | `job_id` | `job_type` | Resume or retry a resumable or failed job. |
| `abort_job` | `job_id` | `job_type` | Abort a running or queued job and release its lease. |

```json
{ "db": "myapp/main", "operation": "list_jobs", "payload": {"job_type": "import_jsonl", "status": "failed"} }
```

Terminal import/export job history is retained for `KOKOADB_JOB_RETENTION_DAYS` (default 30).

---

## Identity store

Identity operations store login-related **metadata** for your app.

> **Kokoadb does not authenticate.** It never verifies passwords, validates OAuth tokens, issues sessions, or enforces permissions. It stores users, provider links, statuses, and token hashes so your application does not have to build that schema.

Internal tables:

| Table | Contents |
|---|---|
| `__kdb_identity_users` | Local user/account metadata. |
| `__kdb_identity_providers` | Google/GitHub/custom provider mappings. |
| `__kdb_identity_tokens` | App-generated token hashes. |
| `__kdb_identity_events` | Append-only identity lifecycle events. |

**Rules**

- User ids default to dashless UUIDv4. `user_create` accepts any non-empty string as a caller-provided `user_id`; the value is trimmed and otherwise preserved.
- `first_name`, `last_name`, and `profile_photo` are first-class profile columns.
- `requires_password_change` is an application-facing signal. Kokoadb stores and returns it but does not enforce login behavior.
- Presentation preferences such as `display_name`, `timezone`, and `locale` belong in `data`.
- **Store `password_hash`, never raw passwords. Store `token_hash`, never raw tokens.**
- Status values are app-defined strings.
- Soft-deleted users keep email and provider identity reserved.
- `purge: true` hard-deletes the user, providers, tokens, and events.
- `password_hash` is excluded from all identity reads by default. Only `user_get` with `include_credentials: true` adds it to the returned user item.
- Treat `include_credentials: true` as server-to-server behavior. Do not expose the Kokoadb access key, submitted password, or returned hash to a browser or untrusted client.

### `user_create`

**Optional payload:** `user_id`, `email`, `username`, `phone`, `first_name`, `last_name`, `profile_photo`, `status` (default `active`), `status_reason`, `password_hash`, `password_algo`, `requires_password_change` (default `false`), `provider`, `provider_user_id`, `data`.

```json
{
  "db": "app/main",
  "operation": "user_create",
  "payload": {
    "email": "user@example.com",
    "username": "mardix",
    "first_name": "Mardix",
    "last_name": "Example",
    "profile_photo": "s3://app-files/avatars/user.png",
    "password_hash": "$argon2id$...",
    "password_algo": "argon2id",
    "requires_password_change": true,
    "data": {"display_name": "Mardix", "role": "admin"}
  }
}
```

Create and link a provider identity in one call:

```json
{
  "db": "app/main",
  "operation": "user_create",
  "payload": {
    "email": "user@gmail.com",
    "provider": "google",
    "provider_user_id": "10982374238947238947",
    "data": {"name": "Jane Doe"}
  }
}
```

### `user_get`

**Required:** one of `user_id`, `id`, `email`, `username` — or `provider` + `provider_user_id`.

```json
{ "db": "app/main", "operation": "user_get", "payload": {"email": "user@example.com"} }
```

Provider lookup, after your app validates the OAuth response:

```json
{ "db": "app/main", "operation": "user_get", "payload": {"provider": "github", "provider_user_id": "827364"} }
```

Set `include_credentials: true` when a trusted application backend needs the stored password hash for verification. The hash is added directly to the returned user item alongside `id`, `email`, `password_algo`, and the other user fields. `user_query` and `user_get_details` never include it. `user_get` does not use the query-response cache.

```json
{
  "db": "app/main",
  "operation": "user_get",
  "payload": {
    "email": "user@example.com",
    "include_credentials": true
  }
}
```

Response:

```json
{
  "status": "success",
  "data": {
    "item": {
      "id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
      "email": "user@example.com",
      "status": "active",
      "password_hash": "$argon2id$v=19$...",
      "password_algo": "argon2id",
      "requires_password_change": false,
      "password_updated_at": "2026-09-18T14:25:00.000Z"
    }
  }
}
```

If the user does not exist, `item` is `null`. A user created without password credentials has `null` for `password_hash` and `password_algo` when credentials are requested.

The application must use the verification function for `password_algo`; it must not hash the submitted password again and compare strings. For example, with Argon2, pass the submitted plaintext password and returned encoded hash to the Argon2 verifier. Check `status` and `requires_password_change` as part of the application's login policy. Never log or cache the submitted password or returned hash.

### `user_get_details`

Fetches one user together with linked providers, available login methods, and recent lifecycle events. Use it for an account-management or admin detail page where `user_get` alone would need several extra requests.

**Required:** one of `user_id`, `id`, `email`, `username`.

Response includes the user profile and status, linked provider records, inferred login methods (password, Google, GitHub, …), and recent identity events.

```json
{ "db": "app/main", "operation": "user_get_details", "payload": {"user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001"} }
```

### `user_update`

Updates one identity profile. `requires_password_change` accepts both `true` and `false`, so the application can set the requirement and clear it after a successful change.

`data` is **patched** when supplied: omitted fields remain unchanged, including nested fields. Use `{"data": {"$replace": {...}}}` to replace the entire identity data object. Mutation operators, including `$replace`, may also be used at nested paths.

```json
{
  "db": "app/main",
  "operation": "user_update",
  "payload": {"user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "requires_password_change": false}
}
```

### `user_update_password`

Atomically replaces an existing user's password hash. The application must hash the password first.

This updates `password_updated_at`, may set or clear `requires_password_change`, and records a `user.password_updated` identity event.

**Required:** `user_id` or `id`, `password_hash`, `password_algo`. **Optional:** `requires_password_change`.

```json
{
  "db": "app/main",
  "operation": "user_update_password",
  "payload": {
    "user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "password_hash": "$argon2id$v=19$...",
    "password_algo": "argon2id",
    "requires_password_change": false
  }
}
```

### `user_query`

Lists and queries users with pagination.

**Optional:** `search` or `q` (matches id, email, username, phone), `status`, `email`, `username`, `filter`, `page`, `per_page`, `limit`, `offset`.

> The `filter` object queries application-defined data under `data`. **Every field path must begin with `data.`** It supports the same logical, comparison, membership, array, string, existence, and type [filter operators](#filter-operators) as documents. Dedicated columns use the top-level shortcuts instead.

```json
{
  "db": "app/main",
  "operation": "user_query",
  "payload": {"search": "gmail.com", "status": "active", "page": 1, "per_page": 25}
}
```

Query nested identity data:

```json
{
  "db": "app/main",
  "operation": "user_query",
  "payload": {
    "status": "active",
    "filter": {
      "$and": [
        {"data.plan": {"$in": ["pro", "enterprise"]}},
        {"data.preferences.locale": "en-US"},
        {"data.tags": {"$includes": "beta"}}
      ]
    },
    "page": 1,
    "per_page": 25
  }
}
```

### `user_link_provider`

**Required:** `user_id` or `id`, `provider`, `provider_user_id`. **Optional:** `email`, `data`.

```json
{
  "db": "app/main",
  "operation": "user_link_provider",
  "payload": {
    "user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "provider": "github",
    "provider_user_id": "827364",
    "email": "user@example.com",
    "data": {"login": "octocat"}
  }
}
```

### `user_unlink_provider`

**Required:** `provider`, `provider_user_id`. **Optional:** `user_id` or `id` to make the unlink strict to that user.

```json
{
  "db": "app/main",
  "operation": "user_unlink_provider",
  "payload": {
    "user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "provider": "github",
    "provider_user_id": "827364"
  }
}
```

### `user_update_status`

Updates app-defined status, optionally scheduling a future transition.

**Required:** `user_id` or `id`, `status`.
**Optional:** `status_reason`; exactly one of `status_expires_at` or `status_expires_in`; `status_next` (**required** when expiration is provided); `status_next_reason`; `changed_by`.

When `status_expires_at` is reached the reaper applies `status_next` and logs `user.status_transitioned`.

Ban for two days, then return to active:

```json
{
  "db": "app/main",
  "operation": "user_update_status",
  "payload": {
    "user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "status": "banned",
    "status_reason": "abuse",
    "status_expires_in": 172800,
    "status_next": "active",
    "status_next_reason": "temporary ban expired",
    "changed_by": "admin:42"
  }
}
```

### `user_create_token`

Stores one app-generated token hash.

**Required:** `user_id` or `id`, `kind`, `token_hash`.
**Optional:** exactly one of `expires_at` or `expires_in`; `allow_multi` (default `false`); `data`.

- `allow_multi: false` revokes existing active tokens for the same `user_id` + `kind`.
- `token_hash` is unique and is **never** included in responses.
- Expired tokens are removed by the reaper.

```json
{
  "db": "app/main",
  "operation": "user_create_token",
  "payload": {
    "user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "kind": "password_reset",
    "token_hash": "sha256:abc123...",
    "expires_in": 300
  }
}
```

### `user_get_token`

Reads token metadata without exposing `token_hash`. Select by `token_id`/`id`, or by the exact `token_hash` + `kind` pair. The returned `status` is derived as `active`, `used`, `revoked`, or `expired`.

```json
{
  "db": "app/main",
  "operation": "user_get_token",
  "payload": {"token_hash": "sha256:abc123...", "kind": "password_reset"}
}
```

### `user_consume_token`

Atomically marks an active, unexpired token as used. **Concurrent requests cannot both consume the same token:** the first successful update returns `consumed: true`; later, expired, revoked, missing, or mismatched attempts all return the same non-enumerating `{"consumed": false, "item": null}` result. Successful consumption records `user.token_consumed` in the same transaction.

```json
{
  "db": "app/main",
  "operation": "user_consume_token",
  "payload": {"token_hash": "sha256:abc123...", "kind": "password_reset"}
}
```

### `user_revoke_token`

Revokes only active, unexpired tokens. Provide exactly one selector: `token_id`/`id`, `token_hash` + `kind`, or `user_id`/`id` with an optional `kind`. A user selector without `kind` revokes **every** active token for that user.

The response contains `revoked_count` and safe `token_ids`; each change records `user.token_revoked` in the same transaction.

```json
{
  "db": "app/main",
  "operation": "user_revoke_token",
  "payload": {"user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "kind": "api_key"}
}
```

### `user_delete`

**Required:** `user_id` or `id`. **Optional:** `status_reason`, `purge`.

| Mode | Effect |
|---|---|
| Soft delete (default) | Sets `status=deleted` and `deleted_at`, revokes active tokens, keeps email/provider mappings reserved. |
| `purge: true` | Hard-deletes the user, providers, tokens, and events. |

```json
{
  "db": "app/main",
  "operation": "user_delete",
  "payload": {"user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "status_reason": "user requested deletion"}
}
```

```json
{
  "db": "app/main",
  "operation": "user_delete",
  "payload": {"user_id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "purge": true}
}
```

---

## File catalog

File operations store metadata for files or objects your application uploads elsewhere, in `__kdb_files`.

> **Kokoadb does not touch bytes.** It does not upload, download, stream, move, or delete actual files. Object cleanup remains the application's responsibility.

**Rules**

- File ids default to dashless UUIDv4. Caller-provided ids may be any non-empty string; the value is trimmed and otherwise preserved.
- `uploaded_at` is when the app/object store received the file. If omitted, Kokoadb sets it to server UTC now.
- `created_at` is when the metadata row was registered in Kokoadb.
- `owner_type` + `owner_id` are optional generic attachment fields, e.g. `user` + `user_123`, or `invoice` + `inv_001`.
- `file_delete` soft-deletes by setting `status=deleted` and `deleted_at`; `purge: true` hard-deletes the metadata row only.
- Deleted file metadata is hidden from `file_get`, `file_query`, and `get_data_count`. A later `file_delete` with `purge: true` may still permanently remove the hidden row.

### `file_create`

**Required:** `storage_backend`, `storage_path`.
**Optional:** `id`, `bucket` (default `default`), `filename`, `content_type`, `size_bytes`, `sha256`, `status` (default `active`), `owner_type`, `owner_id`, `metadata`, `uploaded_at`, `expires_at`.

```json
{
  "db": "app/main",
  "operation": "file_create",
  "payload": {
    "bucket": "avatars",
    "storage_backend": "s3",
    "storage_path": "s3://app-files/uploads/users/u123/avatar.png",
    "filename": "avatar.png",
    "content_type": "image/png",
    "size_bytes": 182331,
    "sha256": "abc123...",
    "owner_type": "user",
    "owner_id": "u123",
    "metadata": {"width": 512, "height": 512}
  }
}
```

### `file_get`

Returns `item: null` when the id does not exist or was soft-deleted.

```json
{ "db": "app/main", "operation": "file_get", "payload": {"id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001"} }
```

### `file_query`

**Optional:** `bucket`, `status`, `owner_type`, `owner_id`, `storage_backend`, `content_type`, `search` or `q`, `filter`, `page`, `per_page`, `limit`, `offset`.

Only visible, non-deleted records are queried. Rows with `deleted_at` set or `status=deleted` are excluded even when the request supplies another status/filter combination.

> The `filter` object queries the application-defined JSON metadata object. **Every field path must begin with `metadata.`** Dedicated-column selectors can be combined with the JSON filter; all conditions must match.

List all files attached to a user:

```json
{
  "db": "app/main",
  "operation": "file_query",
  "payload": {"owner_type": "user", "owner_id": "u123", "status": "active", "page": 1, "per_page": 25}
}
```

Query nested metadata and an array value:

```json
{
  "db": "app/main",
  "operation": "file_query",
  "payload": {
    "content_type": "image/webp",
    "filter": {
      "$or": [
        {"metadata.image.width": {"$gte": 1024}},
        {"metadata.tags": {"$includes": "retina"}}
      ]
    },
    "page": 1,
    "per_page": 25
  }
}
```

### `file_update`

**Required:** `id`.
**Optional:** `bucket`, `storage_backend`, `storage_path`, `filename`, `content_type`, `size_bytes`, `sha256`, `status`, `owner_type`, `owner_id`, `metadata`, `uploaded_at`, `expires_at`.

`metadata` is **patched** when supplied: omitted fields remain unchanged. Use `{"metadata": {"$replace": {...}}}` to replace the entire object; `$replace` can also target nested metadata paths.

```json
{
  "db": "app/main",
  "operation": "file_update",
  "payload": {
    "id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001",
    "metadata": {"width": 1024, "height": 1024, "variant": "retina"}
  }
}
```

### `file_delete`

**Required:** `id`. **Optional:** `purge`.

```json
{ "db": "app/main", "operation": "file_delete", "payload": {"id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001"} }
```

```json
{ "db": "app/main", "operation": "file_delete", "payload": {"id": "f9c1b3a9e2a84f9aa0bdb88e8c12f001", "purge": true} }
```

The default soft delete preserves the metadata row for retention or recovery purposes but removes it from normal reads and counts. `purge: true` hard-deletes the metadata row, including a row that was already soft-deleted. Neither mode deletes the actual file bytes from the application-managed storage backend.

---


## Metrics events

A lightweight event store for product and SaaS metrics: ingest events, then aggregate them into bucketed, grouped, labeled result sets.

### `metrics_ingest`

Appends one or many metric events.

**Required:** `events` as a non-empty array.

| Event field | Required | Default | Description |
|---|---|---|---|
| `event` | Yes | — | Event name, e.g. `api.request`. |
| `ts` | No | Server UTC now | RFC3339 or `YYYY-MM-DD`. |
| `value` | No | `1` | Numeric value. |
| `tenant_id`, `user_id` | No | — | Optional scoping fields. |
| `dimensions` | No | — | Object of grouping/filtering dimensions. |
| `metadata` | No | — | Arbitrary context. |

- Ingest defaults to `commit: false` (accepted/queued). Set `commit: true` to wait for the SQLite commit.
- Event names are registered in `__kdb_metrics_catalog`; dimension paths are registered under the event name.

```json
{
  "db": "app/main",
  "operation": "metrics_ingest",
  "payload": {
    "events": [
      {
        "event": "api.request",
        "ts": "2026-06-14T13:22:10Z",
        "tenant_id": "tenant_123",
        "user_id": "user_456",
        "value": 1,
        "dimensions": {
          "endpoint": "/v1/chat",
          "method": "POST",
          "status": 200,
          "duration_ms": 183
        },
        "metadata": {"request_id": "req_abc"}
      }
    ]
  }
}
```

```json
{
  "status": "success",
  "data": {"ids": ["evt_abc"], "queued": true},
  "ack_mode": "accepted",
  "ack_status": "queued",
  "committed": false,
  "is_async_ack": true
}
```

### `metrics_query`

Aggregates metric events into one or many labeled result sets.

**Required:** `event` or `events`; `range` or `start` + `end`; `metrics`.

**Optional:** `alias`, `label`, `interval`, `bucket_label`, `filter`, `group_by`, `sort`, `limit`, `offset`, `batch`, `cache`.

#### Time inputs

| Input | Accepted values |
|---|---|
| `start` / `end` | RFC3339 UTC datetime, or `YYYY-MM-DD`. `start` expands to `00:00:00Z`; `end` expands to `23:59:59Z`. |
| `range` (rolling) | `24h`, `7d`, `3days`, `2weeks`, `4months`, `1year` — meaning `now - range` → `now`. |
| `range` (calendar) | `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`, `last_year` — snapped to UTC calendar boundaries. |

Dash aliases are normalized to underscores: `last-month` → `last_month`.

#### Metric operations

`count`, `sum`, `avg`, `min`, `max`, `distinct`, `count_distinct`.

#### Caching

Enabled by default with `KOKOADB_METRIC_EVENTS_CACHE_TTL_SECS=30`. `metrics_ingest` does **not** invalidate the cache on every ingest. `cache: false` bypasses; `cache: N` caches for N seconds; `cache: -1` invalidates the metrics cache for the database.

#### Response shape

- `data.results` is always keyed by result alias.
- Each result includes normalized `range`, `start`, `end`, and `interval`.
- Item group values live under `items[].groups`; computed values under `items[].metrics`.

```json
{
  "db": "app/main",
  "operation": "metrics_query",
  "payload": {
    "alias": "api_requests",
    "label": "API Requests",
    "event": "api.request",
    "start": "2026-06-14",
    "end": "2026-06-14",
    "interval": "hour",
    "bucket_label": "{{bucket HH:mm}}",
    "filter": {
      "tenant_id": "tenant_123",
      "dimensions.status": {"$gte": 200}
    },
    "group_by": [
      {"field": "dimensions.endpoint", "alias": "endpoint", "label": "Endpoint"}
    ],
    "metrics": [
      {"op": "count", "field": "*", "alias": "requests", "label": "Requests"},
      {"op": "avg", "field": "dimensions.duration_ms", "alias": "avg_duration_ms", "label": "Avg duration"}
    ],
    "sort": "bucket asc, requests desc"
  }
}
```

```json
{
  "status": "success",
  "data": {
    "count": 1,
    "results": {
      "api_requests": {
        "alias": "api_requests",
        "label": "API Requests",
        "range": null,
        "start": "2026-06-14T00:00:00Z",
        "end": "2026-06-14T23:59:59Z",
        "interval": "hour",
        "labels": {
          "groups": {"bucket": "Bucket", "bucket_label": "Bucket Label", "endpoint": "Endpoint"},
          "metrics": {"requests": "Requests", "avg_duration_ms": "Avg duration"}
        },
        "count": 1,
        "items": [
          {
            "bucket": "2026-06-14T13:00:00Z",
            "bucket_label": "13:00",
            "groups": {"endpoint": "/v1/chat"},
            "metrics": {"requests": 120, "avg_duration_ms": 183.4}
          }
        ],
        "warnings": []
      }
    }
  }
}
```

#### Batch

Run several independent metric queries in one request. Each entry needs its own `alias`.

```json
{
  "db": "app/main",
  "operation": "metrics_query",
  "payload": {
    "batch": [
      {
        "alias": "api_requests",
        "event": "api.request",
        "range": "24h",
        "interval": "hour",
        "metrics": [{"op": "count", "field": "*", "alias": "requests", "label": "Requests"}]
      },
      {
        "alias": "signups",
        "event": "user.signup",
        "range": "7d",
        "interval": "day",
        "metrics": [{"op": "count", "field": "*", "alias": "signups", "label": "Signups"}]
      }
    ]
  }
}
```

### `metrics_catalog`

Lists discovered event names and dimension paths.

**Optional:** `type` (`event` or `dimension`), `name` (context key; for dimensions this is the event name), `value` (exact catalog value), `limit`, `offset`.

Catalog row shapes:

```json
{"type": "event", "name": "name", "value": "api.request"}
{"type": "dimension", "name": "api.request", "value": "dimensions.endpoint"}
```

List event names:

```json
{ "db": "app/main", "operation": "metrics_catalog", "payload": {"type": "event"} }
```

List dimensions for one event:

```json
{ "db": "app/main", "operation": "metrics_catalog", "payload": {"type": "dimension", "name": "api.request"} }
```

---

## SQL operations

### `sql_execute`

Executes a single SQL statement directly against the current database.

**Required:** `sql`. **Optional:** `params` (positional binds), `commit`.

**Supported statements**

| Category | Statements |
|---|---|
| Read | `SELECT`, `WITH`, `EXPLAIN` |
| Write | `INSERT`, `UPDATE`, `DELETE`, `REPLACE` |
| DDL | `CREATE TABLE`, `CREATE INDEX`, `DROP INDEX`, `ALTER TABLE … ADD COLUMN` |

**Constraints**

- One statement per request.
- Any table or index name using the reserved `__kdb_` or `sqlite_` prefixes is rejected.
- Arbitrary `PRAGMA` is intentionally blocked — use [`sql_get_table_schema`](#sql_get_table_schema) for schema inspection.
- Always available, and protected by normal gateway authentication.
- Write statements use the per-database write coordinator: `commit: false` returns after queueing; committed mode waits for the serialized result.

```json
{
  "db": "myapp/main",
  "operation": "sql_execute",
  "payload": {
    "sql": "SELECT id, email FROM customers WHERE region = ? ORDER BY id LIMIT 25",
    "params": ["us-east"]
  }
}
```

### `sql_list_tables`

Lists user-created SQL tables for the current database. No payload required. Excludes `__kdb_*` and SQLite internal tables.

### `sql_get_table_schema`

Returns schema columns for one user-created table. **Required:** `table`. Excludes internal tables.

This is the safe schema-inspection operation, since `sql_execute` blocks arbitrary `PRAGMA`.

```json
{ "db": "myapp/main", "operation": "sql_get_table_schema", "payload": {"table": "customers"} }
```

---

## Search & Indexes 

### Manual indexes

| Operation | Required | Optional |
|---|---|---|
| `create_index` | `index_path` | `index_name` |
| `drop_index` | `index_name` or `index_path` | — |
| `list_indexes` | — | — |

Kokoadb also indexes automatically: query heatmaps identify frequently filtered or sorted JSON paths and create bounded expression indexes without intervention. Manual indexes complement that for paths you already know are hot.

```json
{ "db": "myapp/main", "operation": "create_index", "payload": {"index_path": "profile.email"} }
```

### Full-text search

FTS uses SQLite FTS5 over **live documents only**.

| Operation | Required | Optional | Purpose |
|---|---|---|---|
| `enable_fts_index` | — | `enable` (default `true`) | Toggles the database-level FTS accessibility flag only. |
| `reindex_fts` | — | — | Enqueues an async rebuild/backfill job. |
| `drop_fts_index` | — | — | Enqueues an async drop job. |

**Getting FTS working**

1. `enable_fts_index` with `enable: true` for the database.
2. `reindex_fts` to create and populate the index. Track it with `get_job`.
3. Run `query` with `payload.search`.

Querying without both steps fails. See [full-text query](#full-text-query) for search syntax, scoring, and constraints.

---



## Namespace lifecycle

### `list_namespaces`

Lists namespaces and their statistics. No payload required.

### `get_namespace_stats`

Reads live/archive counts and bytes for one namespace. **Requires** top-level `namespace`.

### `get_data_count`

Returns a complete exact inventory of stored data in the current database. It always returns every category and accepts no namespace or payload options.

Includes:

- Live and archived document totals and bytes
- Every namespace with live/archive counts and bytes
- Identity user totals with every current status, plus direct `active` and `inactive` counts
- Visible, non-deleted file totals, status counts, and summed file size; soft-deleted rows are excluded
- Metric event count
- Every user-created SQLite table and its exact row count — excluding `__kdb_*`, `sqlite_*`, views, virtual tables, and shadow tables
- `generated_at` in UTC RFC3339

```json
{ "db": "app/main", "operation": "get_data_count", "payload": {} }
```

```json
{
  "status": "success",
  "data": {
    "documents": {
      "total": 125430,
      "archived": 3840,
      "size_bytes": 877570145,
      "archived_size_bytes": 29487210,
      "namespaces": 2,
      "items": [
        {
          "namespace": "orders",
          "total": 78320,
          "archived": 3510,
          "size_bytes": 692841043,
          "archived_size_bytes": 28410931
        }
      ]
    },
    "users": {
      "total": 8420,
      "active": 7901,
      "inactive": 231,
      "statuses": {"active": 7901, "inactive": 231, "suspended": 76, "banned": 12, "deleted": 200}
    },
    "files": {
      "total": 32190,
      "active": 31780,
      "deleted": 410,
      "size_bytes": 58472910234,
      "statuses": {"active": 31780, "deleted": 410}
    },
    "metrics": {"events": 4821040},
    "tables": {"count": 1, "total_rows": 72120, "items": [{"name": "orders_sql", "rows": 72120}]},
    "generated_at": "2026-08-28T15:30:12.421Z"
  }
}
```

### `recompute_stats`

Queues a full rebuild of `__kdb_system_stats`. No payload required.

### `drop_namespace`

**Requires** top-level `namespace`. **Optional:** `ttl_seconds`, `max_docs`, `purge`, `dry_run`.

| `purge` | Behavior |
|---|---|
| `false` (default) | Archive, then delete from live. |
| `true` | Hard delete. |

### `restore_archive`

**Required:** one selector — `txn_id`, `ids`, or namespace/filter.
**Optional:** `on_conflict` (`skip`, `replace`, `patch`), `dry_run`.

### `purge_archive`

Hard-deletes from the archive only.

**Required:** one selector — `txn_id`, `ids`, or namespace/filter. **Optional:** `dry_run`.

### `change_namespace`

Moves documents by reassigning their namespace.

**Required:** `from_namespace`, `to_namespace`. **Optional:** `ids` or `filter`, `max_docs`, `dry_run`.

- Top-level `namespace` is **rejected** for this operation.
- With no selector, **all** documents move from `from_namespace` to `to_namespace`.

### `rename_namespace`

Renames a namespace across live **and** archive data.

**Required:** `from_namespace`, `to_namespace`. Top-level `namespace` is rejected.

---

## Database operations

### `create_db`

Initializes the database at the `db` path. No payload required.

### `db_exists`

Checks existence — remote-aware in `s3` mode. No payload required.

### `clone_db`

Copies the current database to another path. **Required:** `to_db_path`.

### `delete_db`

Permanently removes a live database only after producing a recoverable archive backup. It requires top-level `db` and accepts no payload options.

The operation runs in committed mode and performs these steps in order:

1. Verify that the database exists.
2. In S3 storage mode, force a snapshot/manifest synchronization.
3. Create a compressed backup using the configured backup backend.
4. Add `-archive-YYYYMMDDTHHMMSSZ` to the generated backup filename.
5. Only after the backup succeeds, remove the local database, WAL/SHM files, and all live S3 objects for that database.
6. Clear its connection, write queue, pending-write state, cache state, runtime counters, and system-catalog inventory row.

If snapshot or backup creation fails, deletion does not begin and the live database remains intact. A successful deletion cannot be rediscovered by `list_all_dbs` because its live local and remote artifacts are gone; the archive backup remains at the returned `backup_path`.

```json
{
  "db": "tenant/app.main",
  "operation": "delete_db",
  "payload": {}
}
```

The response includes `backup_path`, `backup_tag`, `archive_timestamp`, `local_deleted`, and `remote_objects_deleted`. The generated `backup_tag` is `archive-YYYYMMDDTHHMMSSZ`.

### Backups

| Operation | Required | Optional |
|---|---|---|
| `create_backup` | — | `backup_db_path`, `backup_tag` |
| `restore_backup` | One of `backup_db_path`, `backup_id`, `backup_tag`, `backup_at`, `latest: true` | — |
| `list_backups` | — | `backup_tag`, `limit`, `offset` |
| `tag_backup` | `backup_id` or `backup_db_path` | `backup_tag` (omit to clear) |

Backups are compressed and catalogued in `__kdb_backup_catalog`. Retention is governed by `KOKOADB_BACKUP_RETENTION_DAYS` (default 30), with an internal count cap as a safety bound. `KOKOADB_BACKUP_EVERY_SECS` controls change-aware automatic backups; `0` disables only the automatic ones.

### S3 replication and snapshots

These operations apply in `KOKOADB_STORAGE_MODE=s3`.

| Operation | Required | Optional | Purpose |
|---|---|---|---|
| `load_db` | `db` | — | Preload/hydrate the database into the active instance. |
| `offload_db` | `db` | — | Sync, then unload the local copy and connection. |
| `sync_db` | `db` | — | Force snapshot + manifest sync. |
| `create_snapshot` | `db` | — | Documented alias of `sync_db`. |
| `list_snapshots` | `db` | — | List versioned snapshots. |
| `restore_snapshot` | `db` | `snapshot_id` (latest if omitted) | Restore the local database from a snapshot. |
| `get_sync_status` | `db` | — | Inspect local and remote state. |
| `verify_db` | `db` | — | Verify manifest, snapshot, and segment object presence. |
| `compact_wal` | `db` | `retain_segments` (default `1000`) | Compact the manifest segment list. |

In S3 mode, `manifest.current_snapshot_id` selects the active snapshot. Snapshot and WAL object references stored in the manifest are relative to the database directory, such as `snapshots/<snapshot_id>.db` and `wal/<epoch>/<sequence>.json`. This makes a complete database directory relocatable within the configured bucket and prefix. Hydration, verification, restore, and signed downloads resolve those references against the manifest's current location. Existing manifests containing full object keys remain readable and are normalized the next time they are written. No duplicate `current.db` is written.

### `vacuum_db` and `reap_db`

`vacuum_db` runs SQLite `VACUUM`, queued as a job.

`reap_db` runs TTL/archive cleanup **and** due document lifecycle transitions immediately. The response includes normal TTL/archive counters plus a `document_transitions` block with `claimed_count`, `completed_count`, `skipped_count`, and `failed_count` for the bounded lifecycle pass.

> The background TTL reaper checks active databases on a fixed interval but only publishes an S3 checkpoint when it actually archives, deletes, expires, or transitions data. An idle reaper run does not upload a snapshot.

---

## System and monitoring

### Instance inventory

These are **global** operations — omit `db`.

| Operation | Purpose |
|---|---|
| `list_commands` | All supported gateway command names. |
| `list_dbs` | Databases currently loaded/open by this instance. |
| `list_all_dbs` | All known databases. `local` mode scans the filesystem; `s3` mode unions loaded + local + remote manifests. |

### System catalog

The system catalog lives at `${KOKOADB_DATA_DIR}/__kdb_system.db` and is always available; live discovery remains the fallback during refreshes.

| Operation | Scope | Notes |
|---|---|---|
| `system_get_inventory` | Global | Reads database inventory from the catalog. Does **not** scan or refresh. Accepts `limit`, `offset`. |
| `system_refresh_inventory` | Global | Scans local/S3 known databases and upserts current state. Records a `system.inventory_refreshed` event. |
| `purge_system_db` | Global | Deletes the local `${KOKOADB_DATA_DIR}/__kdb_system.db` (including WAL/SHM), recreates it, and repopulates inventory from databases currently discoverable locally or in S3. Accepts no payload options. |
| `system_get_db_status` | Global, requires top-level `db` | Live status plus the catalog row. |
| `system_snapshot_db_stats` | Global | With no `db`, snapshots currently active databases. With `db`, snapshots that one. Writes to `__kdb_system_db_stats`. |
| `system_query_db_stats` | Global, optional `db` | Optional `start`, `end` (RFC3339), `limit` (default 100), `offset` (default 0). |
| `system_list_db_events` | Global, optional `db` | Database lifecycle/error events. Optional `limit`, `offset`. |

The background reaper cadence also snapshots active databases into the catalog. Historical stats and events are retained for `KOKOADB_SYSTEM_RETENTION_DAYS` (default 14); inventory rows remain.

```json
{ "operation": "system_get_inventory", "payload": {"limit": 100, "offset": 0} }
{ "operation": "system_refresh_inventory", "payload": {} }
{ "operation": "purge_system_db", "payload": {} }
{ "db": "app/main", "operation": "system_get_db_status", "payload": {} }
{ "db": "app/main", "operation": "system_query_db_stats", "payload": {"limit": 100} }
{ "operation": "system_list_db_events", "payload": {"limit": 50} }
```

### Runtime statistics

| Operation | Purpose |
|---|---|
| `get_system_stats` | Instance-local runtime stats. |
| `system_memory` | Compatibility view for process memory and write-queue usage; includes the same `system_stats` block. |
| `cleanup_temp_artifacts` | Removes stale temp files under the data directory. |

`get_system_stats` includes uptime, version, request totals, in-flight requests, read/write/admin/error counts, average and max latency, 5m/15m/30m/1h rolling windows, process memory, active database count and cap, background worker concurrency, and write queue usage.

> These stats live **in memory and reset when the process restarts.** Use `snapshot_db_stats` / `system_snapshot_db_stats` for durable history.

### Per-database statistics

| Operation | Required | Purpose |
|---|---|---|
| `get_system_config` | `db` | Returns `__kdb_system_config` rows for the current database. |
| `get_db_stats` | `db` | Live in-memory counters: `requests_total`, `reads_total`, `writes_total`, `errors_total`, `in_flight`, `last_accessed_at`. |
| `snapshot_db_stats` | `db` | Writes one snapshot row into `__kdb_db_stats_rollups`. |
| `query_db_stats` | `db` | Query snapshots. Optional `start`, `end` (RFC3339), `limit` (default 100, max 1000). |

Snapshots record **cumulative totals** — calculate interval activity by diffing two snapshots.

```json
{
  "db": "app/main",
  "operation": "query_db_stats",
  "payload": {
    "start": "2026-06-20T00:00:00Z",
    "end": "2026-06-21T00:00:00Z",
    "limit": 100
  }
}
```

---

## Configuration

`kokoadb.env` is the canonical environment template.

`KOKOADB_*` is the supported configuration prefix.

Kokoadb exposes deployment choices, API semantics, retention, and bounded resource controls. Low-level worker thresholds use internal defaults selected by `KOKOADB_RUNTIME_PROFILE`.

**Always enabled:** SQL execution, FTS capability, metric events, auto-indexing, JSONB storage, the system catalog, safe hydration, temporary-file cleanup, and background job workers. Per-database `fts_enabled` still controls whether a specific database can be searched.

### Server, web, and authentication

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_PORT` | `6543` | HTTP listen port. |
| `KOKOADB_BASE_PATH` | `/_/kdb` | Prefix for `/gateway`, `/ping`, `/meta/operations`, `/doc`, `/admin/`. |
| `KOKOADB_AUTH_MODE` | `access_key` | `access_key` requires credentials; `none` permits unauthenticated access. Invalid values fail startup. |
| `KOKOADB_ACCESS_KEY` | empty | `X-Access-Key` value and browser Basic-auth password. Required when mode is `access_key`. |
| `KOKOADB_CORS_ALLOWED_ORIGINS` | empty | Comma-separated origins for standalone browser clients. The bundled Admin UI is same-origin. |
| `KOKOADB_MAX_REQUEST_BYTES` | `16777216` | Maximum HTTP request body bytes (16 MiB). |
| `KOKOADB_OPERATION_TIMEOUT_MS` | `30000` | Gateway operation timeout. |
| `KOKOADB_ADMIN_UI_ENABLED` | `true` | Serve the bundled SPA at `${BASE_PATH}/admin/`. |
| `KOKOADB_DOCS_ENABLED` | `true` | Serve rendered Markdown at `${BASE_PATH}/doc`. |
| `KOKOADB_DOCS_FILE` | `DOCUMENTATION.md` | Markdown source rendered by `/doc`. |

Kokoadb fails at startup when `KOKOADB_AUTH_MODE` is invalid, or when `access_key` mode has no key.

### Storage and S3

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_STORAGE_MODE` | `local` | `local` or `s3`. |
| `KOKOADB_DATA_DIR` | `./data` | Local durable root, or the S3-mode working-file root. Docker uses `/data`. |
| `KOKOADB_S3_BUCKET` | empty | Required in `s3` mode. |
| `KOKOADB_S3_PREFIX` | `data/kokoadb/data` | Base object prefix for database artifacts. |
| `KOKOADB_S3_REGION` | `us-east-1` | S3 region. |
| `KOKOADB_S3_ENDPOINT` | empty | Optional custom S3-compatible endpoint. |
| `KOKOADB_S3_ACCESS_KEY` | empty | S3 access key. |
| `KOKOADB_S3_SECRET_KEY` | empty | S3 secret key. |
| `KOKOADB_S3_SESSION_TOKEN` | empty | Optional temporary-credential token. |

### Runtime and concurrency

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_RUNTIME_PROFILE` | `balanced` | `memory`, `balanced`, or `throughput`. Controls internal cache, queue, batch, idle-close, lookup, and concurrency defaults. |
| `KOKOADB_MAX_ACTIVE_DBS` | profile (`100`) | Hot/open database connections. Beyond the cap, least-recently-used connections are evicted. |
| `KOKOADB_WORKER_CONCURRENCY` | profile (`4`) | Shared database-work concurrency for the reaper, backups, jobs, and remote sync. |

**Profile defaults**

| Profile | Active DBs | Worker concurrency | Read cache entries | Write queue | Export/metric batch |
|---|---|---|---|---|---|
| `memory` | 25 | 2 | 2,500 | 2,500 | 500 |
| `balanced` | 100 | 4 | 10,000 | 10,000 | 1,000 |
| `throughput` | 250 | 8 | 50,000 | 50,000 | 5,000 |

### Replication and snapshots

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_S3_TOPOLOGY` | `single` | `single` disables periodic remote polling for one active instance; `multi` enables cross-instance manifest polling. Writer leases remain active in both. |
| `KOKOADB_REPLICATION_MODE` | `async` | `sync` waits for remote persistence; `async` flushes through the background replication worker. |
| `KOKOADB_PRELOAD_DBS` | empty | Comma-separated S3-mode database paths loaded at startup. |
| `KOKOADB_SNAPSHOT_EVERY_WRITES` | `100` | Target versioned snapshot cadence. Recovery keeps a safe checkpoint per replicated batch, because replication segments are operation metadata rather than replayable database deltas. |
| `KOKOADB_SNAPSHOT_RETENTION_DAYS` | `14` | Versioned snapshot age retention. |
| `KOKOADB_REMOTE_SYNC_INTERVAL_SECS` | `10` | Manifest polling interval in `multi` topology. Ignored in `single`; `0` disables polling. |

Writer leases, WAL segment size, flush cadence, safe hydrate, integrity checks, snapshot count cap, and temporary-artifact cleanup use fixed safe defaults.

> Prefer `single` topology when only one Kokoadb process serves the S3 prefix — it avoids continuous manifest `GET` requests.

### Reads, writes, and responses

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_CACHE_TTL_SECS` | `60` | Default read-cache TTL; `0` disables the read cache. |
| `KOKOADB_WRITE_MODE` | `committed` | `direct` bypasses the coordinator; `committed` waits; `accepted` queues and acknowledges. `payload.commit` overrides committed vs accepted. |
| `KOKOADB_QUERY_DEFAULT_LIMIT` | `50` | Default query and per-lookup limit. |
| `KOKOADB_QUERY_MULTI_MAX_QUERIES` | `20` | Maximum child queries in one `multi_query`. |
| `KOKOADB_QUERY_LOOKUP_MAX_DEPTH` | `3` | Maximum nested lookup depth. |
| `KOKOADB_QUERY_LOOKUP_UNCAPPED_OVERRIDE_ENABLED` | `false` | Allows a request to override lookup depth beyond the configured cap. |
| `KOKOADB_RESPONSE_INCLUDE_SYSTEM_TIMESTAMPS` | `true` | Include `_created_at` and `_modified_at`. |
| `KOKOADB_RESPONSE_INCLUDE_NAMESPACE` | `false` | Include `_namespace` by default. |
| `KOKOADB_STRICT_MUTATIONS_OPERATORS` | `false` | Reject invalid mutation operators and operand types instead of leaving them unchanged. |

### Lifecycle, metrics, and history

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_ARCHIVE_TTL_SECS` | empty | Archive retention before permanent purge; empty retains until explicit purge. |
| `KOKOADB_DELETE_DEFAULT_TTL_SECS` | empty | Default soft-delete TTL when the request does not provide one. |
| `KOKOADB_SYSTEM_RETENTION_DAYS` | `14` | System-catalog stats/event retention. Inventory rows remain. |
| `KOKOADB_METRIC_EVENTS_CACHE_TTL_SECS` | `30` | Metrics-query cache TTL; `0` disables metrics caching. |
| `KOKOADB_METRIC_EVENTS_RETENTION_DAYS` | empty | Raw metric-event retention; empty keeps events indefinitely. |

### Backup, export, and jobs

| Setting | Default | Description |
|---|---|---|
| `KOKOADB_BACKUP_PATH` | `./backups` | Backup destination: local path or full `s3://bucket/prefix`. |
| `KOKOADB_BACKUP_EVERY_SECS` | `0` | Change-aware automatic backup maximum staleness; `0` disables **only** automatic backups. |
| `KOKOADB_BACKUP_RETENTION_DAYS` | `30` | Backup artifact age retention. An internal count cap remains as a safety bound. |
| `KOKOADB_EXPORT_PATH` | `./exports` | Generated export destination: local path or full `s3://bucket/prefix`. |
| `KOKOADB_JOB_RETENTION_DAYS` | `30` | Terminal import/export job-history retention. |

Import, export, backup, FTS, and admin job workers run automatically with bounded internal polling and profile-based batches.

---

## Deployment

### Storage modes

| Mode | Backing | Use when |
|---|---|---|
| `local` | Filesystem `.db` files under `KOKOADB_DATA_DIR` | You control the disk and it survives restarts. |
| `s3` | Object store with WAL, manifest, and snapshots in a single remote tier | The container filesystem is ephemeral, or you need remote durability and restore. |

### Docker

The image defaults `KOKOADB_DATA_DIR` to `/data` and declares `/data` as a volume. Local backup and export defaults also move under `/data`:

```env
KOKOADB_DATA_DIR=/data
KOKOADB_BACKUP_PATH=/data/backups
KOKOADB_EXPORT_PATH=/data/exports
```

You can launch without creating a volume — Docker creates an anonymous one — but that is harder to inspect, back up, or reuse. Prefer a named volume or a host-mounted path.

```bash
docker run -p 6543:6543 -v kokoadb-data:/data kokoadb
```

Runtime environment variables take precedence over baked-in env files, so this also works:

```bash
docker run \
  -p 6543:6543 \
  -e KOKOADB_DATA_DIR=/var/lib/kokoadb \
  -v kokoadb-data:/var/lib/kokoadb \
  kokoadb
```

For a self-managed server, a host-mounted path is usually easier to back up than a named volume:

```bash
mkdir -p /srv/kokoadb/data

docker run -d \
  --name kokoadb \
  --restart unless-stopped \
  -p 127.0.0.1:6543:6543 \
  --env-file ./kokoadb.env.prod \
  -v /srv/kokoadb/data:/data \
  kokoadb
```

Binding to `127.0.0.1` keeps Kokoadb private to the host so a reverse proxy — Caddy, Nginx, Traefik — can terminate HTTPS publicly.

### Docker Compose

The repository includes `compose.yaml` as a local durable example.

```bash
docker compose up --build -d
```

It builds the local Dockerfile, builds and serves the Admin UI, loads `kokoadb.env`, overrides Docker-specific settings such as `KOKOADB_DATA_DIR=/data`, stores database files and local backups/exports under `/data`, and creates a named `kokoadb-data` volume mounted there.

Test:

```bash
curl http://localhost:6543/_/kdb/ping
```

```bash
curl -X POST http://localhost:6543/_/kdb/gateway \
  -H 'content-type: application/json' \
  -H 'x-access-key: change-me' \
  -d '{"db":"app/main","operation":"create_db","payload":{}}'
```

Open the Admin UI at `http://localhost:6543/_/kdb/admin/`. When auth is enabled, use `kongodb` as the browser prompt username and your `KOKOADB_ACCESS_KEY` as the password.

For production: replace `change-me`, review `KOKOADB_BASE_PATH`, and consider a host-mounted path if your backup tooling expects normal filesystem paths.

### Cloud Run

Container-local paths such as `/tmp/kokoadb` or `/data` are **instance-local cache only**. Use `s3` mode for durable storage:

```env
KOKOADB_STORAGE_MODE=s3
KOKOADB_DATA_DIR=/tmp/kokoadb
KOKOADB_S3_BUCKET=...
KOKOADB_S3_PREFIX=data/kokoadb/data
KOKOADB_S3_REGION=...
KOKOADB_S3_ACCESS_KEY=...
KOKOADB_S3_SECRET_KEY=...
```

### Production checklist

- [ ] `KOKOADB_AUTH_MODE=access_key` with a long random `KOKOADB_ACCESS_KEY`
- [ ] TLS terminated in front of `/admin/` and `/doc`
- [ ] Bind the container to `127.0.0.1` behind a reverse proxy
- [ ] `KOKOADB_CORS_ALLOWED_ORIGINS` set to exact origins, never `*`
- [ ] Durable storage: a named volume, a host mount, or `s3` mode
- [ ] Backups enabled — `KOKOADB_BACKUP_EVERY_SECS` non-zero, retention reviewed
- [ ] A restore actually tested with `restore_backup` or `restore_snapshot`
- [ ] `KOKOADB_RUNTIME_PROFILE` matched to the instance size
- [ ] Retention reviewed: archive, metric events, jobs, system history

### Smoke scripts

| Script | Requires |
|---|---|
| `./scripts/smoke.sh` | Running server |
| `./scripts/smoke-auth.sh` | Running server with auth enabled |
| `./scripts/smoke-import-s3.sh` | s3-mode server, AWS CLI, `KOKOADB_S3_*` |
| `./scripts/smoke-snapshot.sh` | s3-mode server |
| `./scripts/smoke-safe-hydrate.sh` | s3-mode server, AWS CLI |

---

## Cookbook

Compact copy/paste requests. All examples use `db: "myapp/main"`; add the `X-Access-Key` header in authenticated deployments.

### Documents

```jsonl
{ "db":"myapp/main", "operation":"insert", "namespace":"users", "payload":{"data":{"name":"Ada"}} }
{ "db":"myapp/main", "operation":"insert", "namespace":"users", "payload":{"data":[{"name":"Ada"},{"name":"Bob"}],"unique_fields":["email"],"on_conflict":"skip"} }
{ "db":"myapp/main", "operation":"update", "namespace":"users", "payload":{"data":{"_id":"u1","name":"Ada L"}} }
{ "db":"myapp/main", "operation":"update", "namespace":"users", "payload":{"filter":{"_id":{"$in":["u1","u2"]}},"data":{"plan":"pro"}} }
{ "db":"myapp/main", "operation":"update", "namespace":"users", "payload":{"replace":true,"data":{"_id":"u1","name":"Ada","plan":"pro"}} }
{ "db":"myapp/main", "operation":"upsert", "namespace":"users", "payload":{"filter":{"email":{"$eq":"a@b.com"}},"insert_data":{"email":"a@b.com"},"update_data":{"last_seen":{"@now":true}}} }
{ "db":"myapp/main", "operation":"query", "namespace":"*", "payload":{"filter":{"_id":{"$in":["u1","u2"]}},"fields":["name","email"]} }
{ "db":"myapp/main", "operation":"query", "namespace":"users", "payload":{"filter":{"age":{"$gte":18}},"sort":"age desc","limit":20} }
{ "db":"myapp/main", "operation":"query", "namespace":"users", "payload":{"search":"ada","limit":10} }
{ "db":"myapp/main", "operation":"count", "namespace":"users", "payload":{"filter":{"status":{"$eq":"active"}}} }
{ "db":"myapp/main", "operation":"aggregate", "namespace":"users", "payload":{"compute":{"total":{"$count":"*"},"avg_age":{"$avg":"age"}}} }
{ "db":"myapp/main", "operation":"transaction", "payload":{"operations":[{"operation":"insert","namespace":"users","payload":{"data":{"_id":"u1","name":"Ada"}}},{"operation":"update","namespace":"users","payload":{"data":{"_id":"u1","plan":"pro"}}}]} }
```

### Shorthand aliases

```jsonl
{ "db":"test/db02.main", "operation":"query::users", "payload":{} }
{ "db":"test/db02.main", "operation":"query::*", "payload":{} }
{ "db":"test/db02.main", "operation":"query::users,admins,teams", "payload":{} }
{ "db":"test/db02.main", "operation":"query::users", "payload":{"search":"ada"} }
```

### Lifecycle and archive

```jsonl
{ "db":"myapp/main", "operation":"delete", "payload":{"id":"u1"} }
{ "db":"myapp/main", "operation":"delete", "namespace":"users", "payload":{"filter":{"status":{"$eq":"inactive"}},"max_docs":100} }
{ "db":"myapp/main", "operation":"delete", "payload":{"ids":["u1","u2"]} }
{ "db":"myapp/main", "operation":"drop_namespace", "namespace":"users", "payload":{"ttl_seconds":3600} }
{ "db":"myapp/main", "operation":"set_ttl", "namespace":"users", "payload":{"ids":["u1"],"ttl_seconds":600,"expiry_behavior":"archive"} }
{ "db":"myapp/main", "operation":"restore_archive", "payload":{"txn_id":"tx123","on_conflict":"skip"} }
{ "db":"myapp/main", "operation":"purge_archive", "payload":{"txn_id":"tx123"} }
{ "db":"myapp/main", "operation":"change_namespace", "payload":{"from_namespace":"users","to_namespace":"users_inactive","filter":{"status":{"$eq":"inactive"}}} }
{ "db":"myapp/main", "operation":"list_transitions", "payload":{"status":"failed","per_page":50} }
{ "db":"myapp/main", "operation":"retry_transition", "payload":{"transition_id":"transition_1"} }
```

### Stats, indexes, FTS

```jsonl
{ "db":"myapp/main", "operation":"list_namespaces", "payload":{} }
{ "db":"myapp/main", "operation":"get_namespace_stats", "namespace":"users", "payload":{} }
{ "db":"myapp/main", "operation":"get_data_count", "payload":{} }
{ "db":"myapp/main", "operation":"get_system_config", "payload":{} }
{ "db":"myapp/main", "operation":"recompute_stats", "payload":{} }
{ "db":"myapp/main", "operation":"create_index", "payload":{"index_path":"profile.email"} }
{ "db":"myapp/main", "operation":"drop_index", "payload":{"index_path":"profile.email"} }
{ "db":"myapp/main", "operation":"list_indexes", "payload":{} }
{ "db":"myapp/main", "operation":"enable_fts_index", "payload":{"enable":true} }
{ "db":"myapp/main", "operation":"reindex_fts", "payload":{} }
{ "db":"myapp/main", "operation":"drop_fts_index", "payload":{} }
```

### Database operations

```jsonl
{ "db":"myapp/main", "operation":"create_db", "payload":{} }
{ "db":"myapp/main", "operation":"db_exists", "payload":{} }
{ "operation":"list_commands", "payload":{} }
{ "operation":"list_dbs", "payload":{} }
{ "operation":"list_all_dbs", "payload":{} }
{ "operation":"system_memory", "payload":{} }
{ "db":"myapp/main", "operation":"load_db", "payload":{} }
{ "db":"myapp/main", "operation":"sync_db", "payload":{} }
{ "db":"myapp/main", "operation":"create_snapshot", "payload":{} }
{ "db":"myapp/main", "operation":"list_snapshots", "payload":{} }
{ "db":"myapp/main", "operation":"get_sync_status", "payload":{} }
{ "db":"myapp/main", "operation":"verify_db", "payload":{} }
{ "db":"myapp/main", "operation":"restore_snapshot", "payload":{"snapshot_id":"20260304T010203Z"} }
{ "db":"myapp/main", "operation":"compact_wal", "payload":{"retain_segments":500} }
{ "db":"myapp/main", "operation":"clone_db", "payload":{"to_db_path":"myapp/main_clone"} }
{ "db":"myapp/main", "operation":"create_backup", "payload":{"backup_tag":"nightly"} }
{ "db":"myapp/main", "operation":"restore_backup", "payload":{"backup_tag":"nightly"} }
{ "db":"myapp/main", "operation":"list_backups", "payload":{"limit":20} }
{ "db":"myapp/main", "operation":"tag_backup", "payload":{"backup_id":"bkp_123","backup_tag":"gold"} }
{ "db":"myapp/main", "operation":"offload_db", "payload":{} }
{ "db":"myapp/main", "operation":"vacuum_db", "payload":{} }
{ "db":"myapp/main", "operation":"reap_db", "payload":{} }
```

### Import, export, jobs, SQL

```jsonl
{ "db":"myapp/main", "operation":"import_jsonl", "namespace":"users", "payload":{"source_path":"s3://bucket/path/users.jsonl.zst","on_conflict":"skip"} }
{ "db":"myapp/main", "operation":"export_jsonl", "namespace":"users", "payload":{"target_path":"s3://bucket/exports/users","compress":true} }
{ "db":"myapp/main", "operation":"get_job", "payload":{"job_id":"job_123"} }
{ "db":"myapp/main", "operation":"list_jobs", "payload":{"job_type":"import_jsonl","status":"failed"} }
{ "db":"myapp/main", "operation":"continue_job", "payload":{"job_id":"job_123"} }
{ "db":"myapp/main", "operation":"abort_job", "payload":{"job_id":"job_123"} }
{ "db":"myapp/main", "operation":"sql_list_tables", "payload":{} }
{ "db":"myapp/main", "operation":"sql_get_table_schema", "payload":{"table":"customers"} }
{ "db":"myapp/main", "operation":"sql_execute", "payload":{"sql":"SELECT id, email FROM customers ORDER BY id LIMIT 25","params":[]} }
```

### Product stores

```jsonl
{ "db":"myapp/main", "operation":"metrics_ingest", "payload":{"events":[{"event":"api.request","dimensions":{"endpoint":"/v1/chat","duration_ms":120}}]} }
{ "db":"myapp/main", "operation":"metrics_query", "payload":{"event":"api.request","range":"24h","interval":"hour","metrics":[{"op":"count","field":"*","alias":"requests","label":"Requests"}]} }
{ "db":"myapp/main", "operation":"metrics_catalog", "payload":{"type":"event"} }
{ "db":"myapp/main", "operation":"user_create", "payload":{"email":"a@b.com","password_hash":"$argon2id$...","password_algo":"argon2id"} }
{ "db":"myapp/main", "operation":"user_get", "payload":{"email":"a@b.com"} }
{ "db":"myapp/main", "operation":"user_consume_token", "payload":{"token_hash":"sha256:abc","kind":"password_reset"} }
{ "db":"myapp/main", "operation":"file_create", "payload":{"storage_backend":"s3","storage_path":"s3://files/u1/a.png","owner_type":"user","owner_id":"u1"} }
{ "db":"myapp/main", "operation":"file_query", "payload":{"owner_type":"user","owner_id":"u1","status":"active"} }
```

---

## Behavior notes and limits

### Current limitations

- `group_by` exists in the payload shape but is **not implemented for `aggregate`** — requests fail when it is supplied. Grouped time-series output is available through [`metrics_query`](#metrics_query).
- `query` with `payload.search` targets **live documents only**; archive flags are rejected in FTS mode.
- Lookups cannot join across database files.
- `upsert` is singular on the insert path; there is no bulk upsert.
- Presigned download URLs are S3-only. Local exports and backups are rejected by `create_download_url`.
- `@now` and `@timestamp` do not support month or year shifts.
- Projection cannot reshape individual array elements.
- Recovery keeps a safe checkpoint per replicated batch, because replication segments are operation metadata rather than replayable database deltas.

### Semantics worth remembering

- All system timestamps are UTC.
- `namespace` is the only public document grouping selector.
- `_key` has no special meaning — it is stored, filtered, and returned like ordinary document data.
- `_id` is unique per database, not per namespace.
- `update` never inserts; `insert` never patches.
- Nested transaction inserts default `on_conflict` to `error`, unlike standalone `insert`.
- Failed lifecycle transitions never retry automatically.
- Soft delete and TTL archive cancel pending transitions; restoring a document does not reactivate them.
- Accepted writes do not return lifecycle transition ids.
- In-memory runtime stats reset on process restart.

### Naming

The canonical product name is **Kokoadb** and the supported environment prefix is `KOKOADB_`. One legacy name remains for browser compatibility:

| Surface | Legacy value | Status |
|---|---|---|
| Browser Basic-auth username | `kongodb` | Accepted alongside the canonical `kokoadb` username by `/doc` and `/admin/`. |

Use the canonical forms in new deployments.

---


## License

Kokoadb is licensed under the **MIT License**.

Copyright (c) 2026-Forever Singlebase. All rights reserved.
