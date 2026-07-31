# Pipa Foundation and MySQL Vertical Slice Implementation Plan

> **Archived historical plan (non-normative).** It records the July 2026 foundation work and includes superseded dependency and storage choices. Follow the root README, `CONTRIBUTING.md`, `SECURITY.md` and current manifests for present behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Pipa desktop application that securely stores local MySQL connections, displays the confirmed engine-grouped workspace, executes real MySQL queries through Rust, streams results to the UI, supports cancellation and `Ctrl/Cmd + R`, and restores unsaved query tabs.

**Architecture:** Use a Cargo workspace with a Tauri transport crate, a framework-free `pipa-core` domain crate, a `pipa-store` local persistence crate, and a `pipa-mysql` adapter crate. React owns presentation and interaction state; all credentials, database I/O, persistence, cancellation, and query streaming remain in Rust. Tauri commands handle request/response operations and Tauri channels carry ordered query events.

**Tech Stack:** Rust 1.96, Tauri 2.11, Tokio 1.52, SQLx 0.9, rusqlite 0.40 with bundled SQLCipher, keyring 4.1, React 19.2, TypeScript 7.0, Vite 8.1, Vitest 4.1, Monaco Editor 4.7, TanStack Virtual 3.14, pnpm 11.5.

**Rust Dependency Lock:** Put these exact entries under `[workspace.dependencies]` and consume them with `workspace = true`: `async-trait = "0.1.89"`, `base64 = "0.22.1"`, `bigdecimal = "0.4.10"`, `chrono = { version = "0.4.45", features = ["serde"] }`, `futures-util = "0.3.32"`, `keyring = "4.1.4"`, `rusqlite = { version = "0.40.1", features = ["bundled-sqlcipher-vendored-openssl", "chrono", "uuid"] }`, `secrecy = { version = "0.10.3", features = ["serde"] }`, `serde = { version = "1.0.228", features = ["derive"] }`, `serde_json = "1.0.150"`, `sqlx = { version = "0.9.0", default-features = false, features = ["runtime-tokio", "tls-rustls-ring-native-roots", "mysql", "chrono", "bigdecimal", "json", "uuid"] }`, `tauri = "2.11.5"`, `tauri-build = "2.6.3"`, `tempfile = "3.27.0"`, `thiserror = "2.0.18"`, `tokio = { version = "1.52.3", features = ["macros", "rt-multi-thread", "sync", "time"] }`, `tokio-util = { version = "0.7.18", features = ["rt"] }`, `ts-rs = { version = "12.0.1", features = ["uuid-impl", "serde-json-impl"] }`, `uuid = { version = "1.23.4", features = ["v4", "serde"] }`.

## Global Constraints

- Target Windows, macOS, and Linux desktop; do not add a web deployment target.
- Store all application state locally; never add analytics, remote fonts, remote assets, or cloud APIs.
- Store passwords only in the operating-system credential store; never serialize them into SQLite, logs, query history, or frontend persistence.
- Keep MySQL, PostgreSQL, MongoDB, and Redis as separate engine sections even though this milestone enables only MySQL actions.
- Clicking another connection must not rebind an existing query tab.
- `Ctrl/Cmd + R` executes the selected SQL or the statement containing the cursor and must prevent WebView refresh.
- Loading UI contains only a spinner, a short action label such as `查询中…`, and a necessary cancel action.
- All selectable rows have a minimum 40px target and distinct hover, focus, and selected states.
- Every Rust and TypeScript function, class, and non-obvious logic block requires a doc comment describing parameters, return value, and side effects.
- Build business logic without Tauri types; only `src-tauri` may depend on the transport framework.
- Use TDD for behavior, keep each commit limited to the task being implemented, and do not add PostgreSQL, MongoDB, Redis, SSH, DDL editing, or data mutation in this plan.

## Scope Decomposition

This plan intentionally covers only the first working vertical slice. Create separate follow-up plans for:

1. MySQL metadata, table structure, DDL, editing, transactions, Explain, import, and export.
2. PostgreSQL adapter and PostgreSQL-native types.
3. MongoDB adapter, documents, pipelines, Schema analysis, and indexes.
4. Redis adapter, data structures, TTL, commands, Pub/Sub, and clusters.
5. Cross-database production safety, advanced export, packaging, performance, and release hardening.

## Planned File Structure

```text
.
├── Cargo.toml                         # Rust workspace membership and shared dependency versions
├── package.json                       # Frontend scripts and exact dependency versions
├── pnpm-lock.yaml                     # Reproducible frontend dependency graph
├── vite.config.ts                     # Vite and Vitest configuration
├── src/
│   ├── main.tsx                       # React entry point
│   ├── app/App.tsx                    # Main workspace composition only
│   ├── app/app.css                    # Layout and state styles
│   ├── app/tokens.css                 # Color, spacing, typography, focus, and engine tokens
│   ├── bindings/                      # Generated TypeScript domain types from pipa-core
│   ├── lib/tauriClient.ts             # Typed IPC and channel wrapper
│   ├── features/connections/
│   │   ├── ConnectionSidebar.tsx      # Engine sections and selected connection behavior
│   │   ├── ConnectionForm.tsx         # MySQL connection create/edit form
│   │   └── useConnections.ts          # Connection loading, saving, and selection state
│   ├── features/query/
│   │   ├── QueryWorkspace.tsx         # Query tab, editor, loading, cancel, and result composition
│   │   ├── QueryEditor.tsx            # Monaco integration and Ctrl/Cmd+R behavior
│   │   ├── ResultGrid.tsx             # Virtualized streamed result rendering
│   │   ├── sqlSelection.ts             # Current-statement selection without UI dependencies
│   │   └── useQuerySession.ts          # Ordered query-event reducer and command bridge
│   └── test/setup.ts                   # DOM test setup and Tauri mocks
├── crates/
│   ├── pipa-core/src/
│   │   ├── lib.rs                     # Public domain exports
│   │   ├── adapter.rs                 # DatabaseAdapter contract
│   │   ├── connection.rs              # Engine, environment, connection, and input types
│   │   ├── error.rs                   # Stable user-facing error contract
│   │   └── query.rs                   # Query request, cell values, and streaming events
│   ├── pipa-store/src/
│   │   ├── lib.rs                     # LocalStore composition
│   │   ├── connection_repository.rs   # Encrypted connection profile persistence
│   │   ├── secret_store.rs            # OS keyring and test-memory secret implementations
│   │   └── workspace_repository.rs    # Query tabs and history persistence
│   └── pipa-mysql/src/
│       ├── lib.rs                     # MySQL adapter export
│       ├── adapter.rs                 # Connection test and streaming query implementation
│       └── value.rs                   # Lossless MySQL-to-CellValue conversion
├── src-tauri/
│   ├── src/lib.rs                     # Tauri builder and command registration
│   ├── src/main.rs                    # Desktop entry point only
│   ├── src/commands.rs                # Thin IPC transport functions
│   ├── src/state.rs                   # AppState and query cancellation registry
│   ├── capabilities/main.json         # Minimum main-window capability set
│   └── tauri.conf.json                # Desktop bundle and CSP configuration
├── infra/test/mysql.compose.yml       # Reproducible MySQL 8.4 integration service
└── scripts/verify-foundation.sh       # Complete milestone verification sequence
```

---

### Task 1: Scaffold the Tauri Workspace and Quality Gates

**Files:**
- Create: `Cargo.toml`
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create: `src/app/tokens.css`
- Create: `src/app/app.css`
- Create: `src/test/setup.ts`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/main.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: No application interfaces.
- Produces: `pipa_app_lib::run()` as the desktop entry point and a testable `<App />` React root.

- [ ] **Step 1: Scaffold the official Tauri React template**

Run:

```bash
pnpm dlx create-tauri-app@4.6.2 . --manager pnpm --template react-ts --identifier dev.pipa.app --tauri-version 2 --force --yes
```

Immediately restore `.superpowers/` in `.gitignore` if the scaffold overwrites it. Do not delete `docs/` or the existing Git history.

- [ ] **Step 2: Pin the milestone dependencies and scripts**

Run:

```bash
pnpm add -E @tauri-apps/api@2.11.1 @monaco-editor/react@4.7.0 @tanstack/react-virtual@3.14.5 lucide-react@1.24.0 react@19.2.7 react-dom@19.2.7
pnpm add -DE @tauri-apps/cli@2.11.4 @testing-library/jest-dom@6.9.1 @testing-library/react@16.3.2 @types/react@19.2.17 @types/react-dom@19.2.3 @vitejs/plugin-react@6.0.3 jsdom@29.1.1 typescript@7.0.2 vite@8.1.4 vitest@4.1.10
```

Set these exact scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "tauri": "tauri",
    "check": "pnpm test && pnpm build && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings"
  }
}
```

- [ ] **Step 3: Write the failing application smoke test**

Create `src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the Pipa workspace landmarks", () => {
    render(<App />);
    expect(screen.getByRole("application", { name: "Pipa 数据库工作台" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "数据库连接" })).toBeVisible();
    expect(screen.getByRole("main", { name: "查询工作区" })).toBeVisible();
  });
});
```

- [ ] **Step 4: Run the test and verify the scaffold UI fails it**

Run: `pnpm test -- src/app/App.test.tsx`

Expected: FAIL because the generated template does not expose `App` with the required landmarks.

- [ ] **Step 5: Implement the minimal three-column shell**

Create `src/app/App.tsx`:

```tsx
import "./tokens.css";
import "./app.css";

/** Composes the persistent Pipa desktop workspace without owning feature state. */
export function App() {
  return (
    <div className="app-shell" role="application" aria-label="Pipa 数据库工作台">
      <aside className="activity-rail" aria-label="主功能">P</aside>
      <nav className="connection-panel" aria-label="数据库连接">
        <h1>Pipa</h1>
      </nav>
      <main className="workspace" aria-label="查询工作区">
        <p>选择或创建一个 MySQL 连接</p>
      </main>
    </div>
  );
}
```

Define tokens in `src/app/tokens.css` for neutral surfaces, text, focus ring, 8px spacing, MySQL/PostgreSQL/MongoDB/Redis accents, and light/dark `color-scheme`. Define only the three-column layout and focus-visible rules in `src/app/app.css`.

- [ ] **Step 6: Verify the shell and Rust scaffold**

Run: `pnpm test -- src/app/App.test.tsx && pnpm build && cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all commands PASS.

- [ ] **Step 7: Commit the scaffold**

```bash
git add .gitignore Cargo.toml package.json pnpm-lock.yaml vite.config.ts src src-tauri
git commit -m "chore: scaffold Pipa desktop workspace"
```

### Task 2: Define Core Contracts and Generate TypeScript Bindings

**Files:**
- Create: `crates/pipa-core/Cargo.toml`
- Create: `crates/pipa-core/src/lib.rs`
- Create: `crates/pipa-core/src/adapter.rs`
- Create: `crates/pipa-core/src/connection.rs`
- Create: `crates/pipa-core/src/error.rs`
- Create: `crates/pipa-core/src/query.rs`
- Create: `.cargo/config.toml`
- Modify: `Cargo.toml`
- Generate: `src/bindings/*.ts`

**Interfaces:**
- Consumes: Tokio runtime supplied by the Tauri process.
- Produces: `DatabaseAdapter`, `ConnectionProfile`, `SaveConnectionInput`, `QueryRequest`, `QueryEvent`, `CellValue`, and `AppError`.

- [ ] **Step 1: Write failing serialization and contract tests**

Add tests to `crates/pipa-core/src/query.rs` that assert:

```rust
#[test]
fn query_event_uses_tagged_snake_case_json() {
    let event = QueryEvent::Completed { query_id: Uuid::nil(), affected_rows: 3 };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        serde_json::json!({
            "type": "completed",
            "queryId": "00000000-0000-0000-0000-000000000000",
            "affectedRows": 3
        })
    );
}

#[test]
fn integer_cells_remain_lossless_strings() {
    let cell = CellValue::Integer("9007199254740993".into());
    assert!(serde_json::to_string(&cell).unwrap().contains("9007199254740993"));
}
```

- [ ] **Step 2: Run the tests and verify missing types fail compilation**

Run: `cargo test -p pipa-core`

Expected: FAIL because `QueryEvent` and `CellValue` do not exist.

- [ ] **Step 3: Implement the domain types**

Use `serde(rename_all = "camelCase")`, tagged enums, `uuid::Uuid`, and `ts_rs::TS`. The exact public shapes are:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[ts(type = "string")]
    pub id: Uuid,
    pub name: String,
    pub engine: Engine,
    pub environment: Environment,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub database: Option<String>,
    pub tls_mode: TlsMode,
}

#[derive(Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionInput {
    pub profile: ConnectionProfile,
    #[ts(type = "string")]
    pub password: secrecy::SecretString,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    #[ts(type = "string")]
    pub query_id: Uuid,
    #[ts(type = "string")]
    pub connection_id: Uuid,
    pub sql: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum QueryEvent {
    Started { #[ts(type = "string")] query_id: Uuid },
    Schema { #[ts(type = "string")] query_id: Uuid, columns: Vec<QueryColumn> },
    Batch { #[ts(type = "string")] query_id: Uuid, rows: Vec<Vec<CellValue>> },
    Completed { #[ts(type = "string")] query_id: Uuid, affected_rows: u64 },
    Canceled { #[ts(type = "string")] query_id: Uuid },
    Failed { #[ts(type = "string")] query_id: Uuid, error: AppError },
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CellValue {
    Null,
    Boolean(bool),
    Integer(String),
    Float(f64),
    Decimal(String),
    Text(String),
    Json(serde_json::Value),
    Binary(String),
    DateTime(String),
}
```

`SaveConnectionInput` is deserialize-only because it enters Rust through IPC and must never travel back to the frontend. Implement `Debug` manually so it prints `password: "***"`; do not derive `Serialize` for this or any other secret-bearing type. Enable the `uuid-impl` and `serde-json-impl` features on `ts-rs` so generated bindings match the Rust types.

- [ ] **Step 4: Define the framework-free adapter interface**

Create `crates/pipa-core/src/adapter.rs`:

```rust
#[async_trait::async_trait]
pub trait DatabaseAdapter: Send + Sync {
    fn engine(&self) -> Engine;

    async fn test_connection(
        &self,
        profile: &ConnectionProfile,
        password: &SecretString,
    ) -> Result<(), AppError>;

    async fn query(
        &self,
        profile: &ConnectionProfile,
        password: SecretString,
        request: QueryRequest,
        events: tokio::sync::mpsc::Sender<QueryEvent>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<(), AppError>;
}
```

- [ ] **Step 5: Generate and verify TypeScript bindings**

Set `TS_RS_EXPORT_DIR` to `../src/bindings` with `relative = true` in the root `.cargo/config.toml`, run `cargo test -p pipa-core export_bindings`, and assert `src/bindings/QueryEvent.ts` exists. Commit generated bindings so frontend builds are deterministic.

- [ ] **Step 6: Run contract checks**

Run: `cargo test -p pipa-core && cargo clippy -p pipa-core --all-targets -- -D warnings`

Expected: PASS with no warnings.

- [ ] **Step 7: Commit core contracts**

```bash
git add Cargo.toml .cargo crates/pipa-core src/bindings
git commit -m "feat: define database adapter contracts"
```

### Task 3: Implement Encrypted Local Connection and Workspace Storage

**Files:**
- Create: `crates/pipa-store/Cargo.toml`
- Create: `crates/pipa-store/src/lib.rs`
- Create: `crates/pipa-store/src/connection_repository.rs`
- Create: `crates/pipa-store/src/secret_store.rs`
- Create: `crates/pipa-store/src/workspace_repository.rs`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `ConnectionProfile` and `AppError` from `pipa-core`.
- Produces: `LocalStore::open(path, encryption_key)`, `save_connection`, `list_connections`, `save_workspace`, `load_workspace`, and `SecretStore::{set,get,delete}`.

- [ ] **Step 1: Write failing repository tests using a temporary encrypted database**

Test these behaviors:

```rust
#[test]
fn connection_round_trip_excludes_password() {
    let store = test_store("correct horse battery staple");
    store.save_connection(&mysql_profile()).unwrap();
    assert_eq!(store.list_connections().unwrap(), vec![mysql_profile()]);
    let bytes = std::fs::read(store.path()).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("database-password"));
}

#[test]
fn wrong_encryption_key_cannot_open_database() {
    let path = temp_path();
    LocalStore::open(&path, "first-key").unwrap();
    assert!(LocalStore::open(&path, "wrong-key").is_err());
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cargo test -p pipa-store`

Expected: FAIL because `LocalStore` is not implemented.

- [ ] **Step 3: Implement SQLCipher initialization and migrations**

Open `rusqlite::Connection` with `bundled-sqlcipher-vendored-openssl`, execute `PRAGMA key = ?1`, immediately verify with `SELECT count(*) FROM sqlite_master`, enable WAL, and create these tables:

```sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  database_name TEXT,
  tls_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_tabs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS query_history (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  executed_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement secret-store isolation**

Define:

```rust
pub trait SecretStore: Send + Sync {
    fn set(&self, connection_id: Uuid, secret: &SecretString) -> Result<(), AppError>;
    fn get(&self, connection_id: Uuid) -> Result<SecretString, AppError>;
    fn delete(&self, connection_id: Uuid) -> Result<(), AppError>;
}
```

Implement `KeyringSecretStore` with service name `dev.pipa.app.database` and a `MemorySecretStore` behind `#[cfg(test)]`. Never expose a method that lists secrets.

- [ ] **Step 5: Implement connection and workspace repositories**

Use explicit SQL column lists and transactions. `save_connection` must upsert the profile without accepting a password. `save_workspace` must replace all tab rows in one transaction. `query_history` must retain only the newest 1,000 rows in this milestone.

- [ ] **Step 6: Run storage verification**

Run: `cargo test -p pipa-store && cargo clippy -p pipa-store --all-targets -- -D warnings`

Expected: PASS; the wrong-key test returns a stable `AppError` without revealing the key.

- [ ] **Step 7: Commit local storage**

```bash
git add Cargo.toml crates/pipa-store
git commit -m "feat: add encrypted local workspace storage"
```

### Task 4: Implement the MySQL Adapter and Streaming Query Events

**Files:**
- Create: `crates/pipa-mysql/Cargo.toml`
- Create: `crates/pipa-mysql/src/lib.rs`
- Create: `crates/pipa-mysql/src/adapter.rs`
- Create: `crates/pipa-mysql/src/value.rs`
- Create: `crates/pipa-mysql/tests/mysql_adapter.rs`
- Create: `infra/test/mysql.compose.yml`
- Modify: `Cargo.toml`

**Interfaces:**
- Consumes: `DatabaseAdapter`, `ConnectionProfile`, `QueryRequest`, `QueryEvent`, and `CancellationToken`.
- Produces: `MySqlAdapter::new()` implementing `DatabaseAdapter` with batches of at most 256 rows.

- [ ] **Step 1: Add the reproducible MySQL test service**

Create `infra/test/mysql.compose.yml` with `mysql:8.4`, database `pipa_test`, user `pipa`, password `pipa_test_password`, port `33306`, and a `mysqladmin ping` healthcheck. The service must not mount persistent host storage.

- [ ] **Step 2: Write the failing adapter integration test**

The test must connect to `mysql://pipa:pipa_test_password@127.0.0.1:33306/pipa_test`, execute:

```sql
SELECT
  CAST(9007199254740993 AS SIGNED) AS large_integer,
  CAST(12.3400 AS DECIMAL(10,4)) AS exact_decimal,
  'Pipa' AS label,
  NULL AS empty_value
```

Collect events from an `mpsc` channel and assert the exact order is `Started`, `Schema`, `Batch`, `Completed`; assert the integer and decimal arrive as strings and null arrives as `CellValue::Null`.

- [ ] **Step 3: Run the integration test and verify it fails**

Run:

```bash
docker compose -f infra/test/mysql.compose.yml up -d --wait
cargo test -p pipa-mysql --test mysql_adapter
```

Expected: FAIL because `MySqlAdapter` is not implemented.

- [ ] **Step 4: Implement connection options and connection testing**

Build `MySqlConnectOptions` from the profile, set the database when present, map `TlsMode::{Disabled,Preferred,Required}` to SQLx SSL modes, and expose a 10-second connection timeout. Map authentication, timeout, network, and database errors into stable `AppError` categories while retaining the redacted original message in `technical_details`.

- [ ] **Step 5: Implement streaming and cancellation**

Acquire one pool connection, send `Started`, derive `QueryColumn` values from the first row metadata, and buffer at most 256 rows before sending `Batch`. In the row loop, use `tokio::select!` between `cancellation.cancelled()` and `rows.try_next()`. On cancellation, drop the row stream, close the acquired connection rather than returning it to the pool, send `Canceled`, and return `Ok(())`.

- [ ] **Step 6: Implement lossless MySQL value conversion**

Map signed and unsigned integer families to decimal strings, `DECIMAL/NEWDECIMAL` to strings, floating values to `f64`, JSON to `serde_json::Value`, binary values to base64, date/time values to ISO-like strings, text to UTF-8 with a replacement marker only when decoding fails, and SQL NULL to `CellValue::Null`. Unit-test every mapping category in `value.rs`.

- [ ] **Step 7: Verify streaming, cancellation, and linting**

Run: `cargo test -p pipa-mysql && cargo clippy -p pipa-mysql --all-targets -- -D warnings`

Expected: PASS, including a cancellation test whose final event is `Canceled` and which emits no later batch.

- [ ] **Step 8: Commit the adapter**

```bash
git add Cargo.toml crates/pipa-mysql infra/test/mysql.compose.yml
git commit -m "feat: stream MySQL query results"
```

### Task 5: Expose Thin Tauri Commands and Query Cancellation

**Files:**
- Create: `src-tauri/src/state.rs`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/capabilities/main.json`

**Interfaces:**
- Consumes: `LocalStore`, `SecretStore`, `MySqlAdapter`, and core domain types.
- Produces: IPC commands `list_connections`, `save_mysql_connection`, `test_mysql_connection`, `run_query`, `cancel_query`, `load_workspace`, and `save_workspace`.

- [ ] **Step 1: Write failing command tests against in-memory state**

Test that saving a connection writes the profile to `LocalStore`, writes the password only to `MemorySecretStore`, and returns a profile with no secret field. Test that canceling an unknown query returns `AppError::NotFound`.

- [ ] **Step 2: Run command tests and verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::tests`

Expected: FAIL because the commands and `AppState` do not exist.

- [ ] **Step 3: Implement application state**

Define:

```rust
pub struct AppState {
    pub local_store: Arc<LocalStore>,
    pub secret_store: Arc<dyn SecretStore>,
    pub mysql: Arc<MySqlAdapter>,
    pub cancellations: tokio::sync::Mutex<HashMap<Uuid, CancellationToken>>,
}
```

At startup, load or generate a 32-byte local-database key in the OS keyring, open encrypted SQLite inside `app_data_dir`, and fail startup with a clear message if the keyring or encrypted store is unavailable. Do not fall back to plaintext.

- [ ] **Step 4: Implement the query channel bridge**

Use this transport shape:

```rust
#[tauri::command]
async fn run_query(
    state: tauri::State<'_, AppState>,
    request: QueryRequest,
    on_event: tauri::ipc::Channel<QueryEvent>,
) -> Result<Uuid, AppError>;
```

Create a bounded `mpsc` channel of 8 batches for backpressure, register a `CancellationToken`, spawn the adapter query, forward ordered events to the Tauri channel, and remove the token on every terminal path. `cancel_query` only calls `CancellationToken::cancel()`.

- [ ] **Step 5: Register only required commands and capabilities**

Register only the seven named application commands in `generate_handler!`. Keep `main.json` restricted to the `main` window and `core:default`; registered application commands use Tauri's default local command access. Do not enable filesystem, shell, clipboard-read, HTTP, or remote URL capabilities.

- [ ] **Step 6: Run backend tests**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`

Expected: PASS with no secret value present in formatted errors or debug output.

- [ ] **Step 7: Commit the transport layer**

```bash
git add src-tauri
git commit -m "feat: expose secure desktop query commands"
```

### Task 6: Build the Engine-Grouped Connection Experience

**Files:**
- Create: `src/lib/tauriClient.ts`
- Create: `src/features/connections/ConnectionSidebar.tsx`
- Create: `src/features/connections/ConnectionSidebar.test.tsx`
- Create: `src/features/connections/ConnectionForm.tsx`
- Create: `src/features/connections/ConnectionForm.test.tsx`
- Create: `src/features/connections/useConnections.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`

**Interfaces:**
- Consumes: generated connection types and the connection IPC commands.
- Produces: `selectedConnectionId`, `selectConnection(id)`, and a saved MySQL connection profile for the query workspace.

- [ ] **Step 1: Write failing sidebar interaction tests**

Render two MySQL connections and empty PostgreSQL, MongoDB, and Redis groups. Assert all four engine headings are present, connections appear only under MySQL, the complete row is a button with at least 40px styling, and clicking a row sets both `aria-selected="true"` and the `is-selected` class.

- [ ] **Step 2: Write the failing connection-form test**

Fill name, host, port, username, database, password, environment, and TLS mode; click `测试并保存`; assert `test_mysql_connection` runs before `save_mysql_connection`; assert the password never appears in rendered connection rows or browser storage.

- [ ] **Step 3: Run tests and verify they fail**

Run: `pnpm test -- src/features/connections`

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement the typed IPC client and connection hook**

Wrap `invoke` in functions whose names exactly match the Rust commands. Keep password only in form component state and clear it in `finally` after save. `useConnections` owns profiles, selected ID, loading boolean, and a single user-actionable error.

- [ ] **Step 5: Implement the strict engine sections and strong selected state**

Render MySQL, PostgreSQL, MongoDB, and Redis as separate bordered sections with engine heading, connection count, and independent empty state. Only MySQL exposes `添加连接` in this milestone. Selected rows use surface fill, 2px outline, left marker, check icon, and environment badge; keyboard focus uses a different ring.

- [ ] **Step 6: Verify connection UX**

Run: `pnpm test -- src/features/connections && pnpm build`

Expected: PASS; TypeScript reports no unsafe `any` in the IPC boundary.

- [ ] **Step 7: Commit the connection UI**

```bash
git add src/lib src/features/connections src/app
git commit -m "feat: add engine-grouped connection workspace"
```

### Task 7: Implement Query Selection, Streaming Results, and Minimal Loading

**Files:**
- Create: `src/features/query/sqlSelection.ts`
- Create: `src/features/query/sqlSelection.test.ts`
- Create: `src/features/query/QueryEditor.tsx`
- Create: `src/features/query/QueryEditor.test.tsx`
- Create: `src/features/query/useQuerySession.ts`
- Create: `src/features/query/useQuerySession.test.ts`
- Create: `src/features/query/QueryWorkspace.tsx`
- Create: `src/features/query/ResultGrid.tsx`
- Create: `src/features/query/ResultGrid.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/app.css`

**Interfaces:**
- Consumes: `selectedConnectionId`, `run_query`, `cancel_query`, and `QueryEvent`.
- Produces: an immutable query-tab context, ordered result state, and user-visible `查询中…`/cancel behavior.

- [ ] **Step 1: Write failing SQL selection tests**

Cover selection precedence and cursor statement extraction:

```ts
expect(sqlToExecute("select 1;\nselect 2;", { start: 0, end: 8 }, 18)).toBe("select 1");
expect(sqlToExecute("select ';' as value;\nselect 2;", null, 26)).toBe("select 2");
expect(sqlToExecute("select 1 /* ; */;\nselect 2;", null, 25)).toBe("select 2");
expect(sqlToExecute("select 1 -- ;\n;\nselect 2;", null, 27)).toBe("select 2");
```

- [ ] **Step 2: Implement the quote/comment-aware statement scanner**

Use a single pass with states `normal`, `single_quote`, `double_quote`, `backtick`, `line_comment`, and `block_comment`. Semicolons split statements only in `normal`. Return selected non-whitespace text first; otherwise return the non-empty statement containing the cursor. Document the scanner's escaping rules and side-effect-free behavior.

- [ ] **Step 3: Write failing query-session reducer tests**

Assert `Started` sets `running`, `Schema` replaces columns, each `Batch` appends rows, `Completed` clears loading, `Canceled` retains received rows and sets `incomplete`, and `Failed` clears loading while preserving SQL and context. Ignore events whose query ID is not the current run.

- [ ] **Step 4: Implement the channel-backed query session**

Create a `Channel<QueryEvent>`, assign `onmessage` before invoking `run_query`, and dispatch events through a pure reducer. Prevent parallel runs in the same tab. `cancel()` invokes `cancel_query` once and leaves the short `查询中…` indicator visible until the terminal event arrives.

- [ ] **Step 5: Implement Monaco and `Ctrl/Cmd + R`**

Register a Monaco action with keybinding `KeyMod.CtrlCmd | KeyCode.KeyR`. Read selected text or call `sqlToExecute` with the cursor offset. Also add a capturing DOM `keydown` guard that calls `preventDefault()` for `Ctrl/Cmd + R` while the app is focused so the WebView never reloads.

- [ ] **Step 6: Implement the minimal loading and virtual result grid**

While running, show only a small spinner, `查询中…`, and `取消`. When rows exist and another batch is expected, show `正在加载更多…` at the bottom. Use `useVirtualizer` for rows; render `CellValue::Integer` and `Decimal` as strings, JSON as compact JSON, binary as `Binary`, and null as a muted `NULL` token.

- [ ] **Step 7: Verify query interaction**

Run: `pnpm test -- src/features/query && pnpm build`

Expected: PASS; tests confirm cancel remains available and no elapsed-time, row-count, or connection-stage text appears in Loading.

- [ ] **Step 8: Commit the query workspace**

```bash
git add src/features/query src/app
git commit -m "feat: add cancellable MySQL query workspace"
```

### Task 8: Restore Unsaved Tabs and Record Local Query History

**Files:**
- Modify: `crates/pipa-core/src/query.rs`
- Modify: `crates/pipa-store/src/workspace_repository.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/features/query/useWorkspacePersistence.ts`
- Create: `src/features/query/useWorkspacePersistence.test.ts`
- Modify: `src/features/query/QueryWorkspace.tsx`

**Interfaces:**
- Consumes: query tabs with immutable connection IDs and executed SQL.
- Produces: debounced `save_workspace`, startup `load_workspace`, and local history written only after a query starts successfully.

- [ ] **Step 1: Write failing persistence tests**

Use fake timers to assert SQL edits debounce for 500ms, switching selected connections does not mutate a restored tab's connection ID, and an unmount flushes the latest text. Assert query history is recorded after `Started`, not when execution fails before reaching the adapter.

- [ ] **Step 2: Run persistence tests and verify they fail**

Run: `pnpm test -- src/features/query/useWorkspacePersistence.test.ts`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement workspace and history commands**

`load_workspace` returns ordered tabs. `save_workspace` replaces tabs transactionally. `record_query_history` stores connection ID, SQL text, and UTC execution time, then deletes rows beyond 1,000. Never store result rows or passwords.

- [ ] **Step 4: Implement debounced frontend persistence**

Load once at startup. Save after 500ms of inactivity and flush on `visibilitychange` when the document becomes hidden. If persistence fails, keep editor contents in memory and show one non-blocking error; do not clear or reload the workspace.

- [ ] **Step 5: Verify restart behavior**

Run: `pnpm test -- src/features/query && cargo test -p pipa-store && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS; serialized workspace contains SQL text and connection IDs but no result data.

- [ ] **Step 6: Commit workspace recovery**

```bash
git add crates/pipa-core crates/pipa-store src-tauri src/features/query
git commit -m "feat: restore local query workspace"
```

### Task 9: Add Milestone Verification and Developer Documentation

**Files:**
- Create: `scripts/verify-foundation.sh`
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: all milestone commands and the MySQL Docker service.
- Produces: one repeatable verification command and documented local setup.

- [ ] **Step 1: Write the verification script**

The executable script must use `set -euo pipefail`, start MySQL with `docker compose ... up -d --wait`, install locked dependencies with `pnpm install --frozen-lockfile`, run frontend tests/build, run Rust fmt/check/tests/clippy, and always stop the container in a trap.

Exact verification body:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm tauri build --debug
```

- [ ] **Step 2: Document setup and architecture**

`README.md` must include prerequisites, `pnpm tauri dev`, the verification command, the four Rust crate responsibilities, the local-only data policy, MySQL test credentials, and the explicit statement that PostgreSQL/MongoDB/Redis actions are not enabled in this milestone.

- [ ] **Step 3: Run the full verification**

Run: `./scripts/verify-foundation.sh`

Expected: exit 0, all tests pass, and a debug desktop bundle is produced under `src-tauri/target/debug/bundle/` or the Cargo workspace target equivalent.

- [ ] **Step 4: Perform manual acceptance checks**

Run `pnpm tauri dev` and verify:

1. The four engine sections are visually separate.
2. A MySQL connection can be tested, saved, selected, and reopened after restart.
3. Selecting another connection does not change an existing query tab.
4. `Ctrl/Cmd + R` executes selected SQL or the cursor statement without refreshing the app.
5. Loading shows only the agreed short label and cancel action.
6. A large recursive or sleep query can be canceled while the window remains responsive.
7. Unsaved SQL returns after restarting the app.
8. No password appears in SQLite strings, logs, frontend storage, or error details.

- [ ] **Step 5: Commit milestone verification**

```bash
git add README.md scripts/verify-foundation.sh .gitignore
git commit -m "docs: add foundation verification workflow"
```

## Milestone Exit Criteria

- `./scripts/verify-foundation.sh` exits successfully on the development Mac.
- The app launches as a native Tauri window and has no remote network dependencies other than user-configured databases.
- MySQL connection profiles survive restart while secrets remain only in the OS keyring.
- MySQL SELECT results arrive in ordered batches and preserve large integers and decimals without JavaScript precision loss.
- Query cancel reaches a terminal `Canceled` event and the UI remains responsive.
- The confirmed engine grouping, strong selected state, immutable tab context, `Ctrl/Cmd + R`, and simplified Loading are covered by automated tests.
- Workspace recovery restores unsaved SQL but not query result data.
- Git status is clean after the final verification commit.
