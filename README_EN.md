<div align="center">
  <img src="https://alasicplat.github.io/brand/alasic.png" width="72" height="72" alt="Alasic" />

  <a href="README.md">简体中文</a> · <strong>English</strong>

  # Pipa

  **Beyond SQL: controlled database access for AI and readable transaction forensics from Binlog.**

  A local-first database workbench for macOS, created and maintained by [Alasic333](https://github.com/AlasicPlat).

  [![Latest release](https://img.shields.io/github/v/release/AlasicPlat/pipa?label=latest)](https://github.com/AlasicPlat/pipa/releases/latest)
  [![CI](https://github.com/AlasicPlat/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/AlasicPlat/pipa/actions/workflows/ci.yml)
  [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
  ![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-111111?logo=apple&logoColor=white)

  [Download for Apple silicon](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg)
  ·
  [Download for Intel](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg)
</div>

<p align="center">
  <img src="docs/assets/pipa-intro-preview.gif" width="100%" alt="Animated demo of Pipa SQL, MCP, and Binlog features" />
</p>

## What is Pipa?

Pipa is a local-first database workbench for macOS. It covers everyday MySQL and Redis tasks, controlled local MCP access, and offline MySQL Binlog analysis.

Pipa does not depend on a Pipa-operated cloud service. It only connects to databases explicitly configured by the user, the MCP service on the local loopback interface, and GitHub Releases for update checks and downloads. Runtime code such as the Monaco editor is bundled locally with the app.

## MCP: AI can read; writes require approval

Pipa includes a Streamable HTTP MCP server that listens only on `127.0.0.1`. Local AI tools can use it to inspect MySQL connections, schemas, and data, or analyze Binlog files directly.

- Read-only SQL runs after passing the safety policy and returns at most 200 rows. Writes and DDL are only added to a confirmation queue.
- Bearer tokens, connection scopes, and loopback-only listening jointly restrict access.
- Open the MCP console to copy the URL, token, or Cursor configuration.

See the [MCP integration guide](docs/MCP_CONNECTION_GUIDE.md) for complete setup instructions, tool parameters, and security policies.

## Binlog: reconstruct transactions offline

Import one or more MySQL Binlog files and analyze them locally without connecting to the original database.

- Inspect transactions by GTID/XID, commit status, affected databases and tables, and Before/After row images. Filter by database, table, or operation type.
- Validate CRC32 checksums and diagnose truncation or compatibility issues. MCP also accepts local paths or Base64-encoded files.
- Generate review-first reset SQL for safely reversible committed transactions. Pipa never executes it automatically and explicitly skips changes that cannot be reliably reversed.

## Everyday database features

- Frequently used statements are saved by database type instead of connection. Organize them into folders and reuse them across test and production connections of the same type.
- Quick Search can filter by connection details, making identically named tables easy to locate in the intended environment.
- Drag query or table workspace tabs outside the current window to create independent work windows.

### MySQL and SQL workspaces

- Create, test, rename, and organize connections, then write and run SQL in independent tabs.
- Run selected SQL or the statement under the cursor, and cancel active queries.
- Stream query results while preserving the original semantics of large integers and exact decimals.
- Select ranges, search, sort, resize columns, and export results as CSV, TSV, JSON, Markdown, SQL INSERT statements, or IN lists.
- Preserve editor and query-result state while switching workspaces during the current run. After restart, unsaved SQL and tab context are restored, but query results are not stored permanently.

### Redis workspaces

- Create, test, and organize Redis connections, switch databases, and browse keys.
- Inspect String, Hash, List, Set, Sorted Set, Stream, RedisJSON, and other key types.
- Run native Redis commands in command workspaces.

Pipa can follow the system appearance or use a manually selected light or dark theme.

## Database support

| Database | Current support |
| --- | --- |
| MySQL | Connection management and testing, SQL queries, offline Binlog analysis, and MCP read-only access |
| Redis | Connection management, database switching, key browsing, key details, and native command execution |
| PostgreSQL | UI placeholder available; connections and queries are not yet enabled |
| MongoDB | UI placeholder available; connections and queries are not yet enabled |

## Download, installation, and updates

| Mac type | Installer |
| --- | --- |
| Apple silicon (M1 / M2 / M3 / M4 and later) | [Download `Pipa-macOS-arm64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg) |
| Intel | [Download `Pipa-macOS-x64.dmg`](https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg) |

Open the DMG and drag Pipa into the Applications folder. Previous versions and release notes are available on the [Releases page](https://github.com/AlasicPlat/pipa/releases).

New versions are distributed through GitHub Releases. Pipa checks `latest.json` in the app and installs only update packages signed by the project's updater private key and verified with the embedded public key. Apple Developer ID signing and notarization establish macOS installation and system trust. The two signing systems are independent, and neither private key is stored in this repository.

## Local data and security boundaries

- Connection settings, database passwords, workspaces, and query history are stored in the SQLCipher-encrypted `pipa-data.db` database inside the application data directory.
- The random root key needed to unlock the main database is stored in `pipa-bootstrap.db` in the same application data directory. On Unix systems, Pipa restricts the directory to `0700` and the bootstrap file to `0600` where possible.
- This design mainly prevents disclosure when the main database file is copied or inspected on its own. A process that can read the current user's entire application data directory can also retrieve the bootstrap key and decrypt the main database. It does not replace separate operating-system accounts, FileVault, or other disk encryption and file-permission controls.
- Database passwords, SQL, query results, and connection data are never written to browser storage. `localStorage` only contains non-sensitive UI preferences such as the theme, shortcuts, and sidebar state.
- Query results and Binlog analysis remain only in process memory and are released when the related workspace is closed or the app exits.
- MCP tokens are only used by the local loopback service and can be rotated at any time. Logs and errors remain redacted.
- The Tauri WebView uses a restrictive CSP, and editor scripts and workers are loaded from the application bundle.

Report security issues privately according to [SECURITY.md](SECURITY.md). Do not include passwords, connection strings, private keys, or unredacted result data in a public issue.

## Local development

### Requirements

- macOS and Xcode Command Line Tools.
- The stable Rust toolchain with `cargo`, `rustfmt`, and `clippy`.
- Node.js 20.19+ or 22.12+, and pnpm 11.
- Docker Desktop or an equivalent Docker Engine for MySQL integration tests.

Install dependencies and open the Tauri development window:

~~~bash
pnpm install --frozen-lockfile
pnpm tauri dev
~~~

### Full verification

The isolated MySQL 8.4 test service is defined in `infra/test/mysql.compose.yml`. The following script starts the test database, runs frontend tests and builds, checks Rust formatting/tests/Clippy, verifies generated bindings, creates a debug desktop bundle, and stops the container afterward:

~~~bash
./scripts/verify-project.sh
~~~

You can also run individual checks:

~~~bash
pnpm test
pnpm build
pnpm bindings:check
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
~~~

The `pipa` / `pipa_test_password` credentials used by the test container apply only to the repository's isolated `127.0.0.1:33306` test service and must not be used anywhere else.

## Architecture

| Component | Responsibility |
| --- | --- |
| `pipa-core` | Connection, query, result, and error models; SQL risk policies and adapter contracts; TypeScript boundary generation. |
| `pipa-binlog` | Streaming local MySQL Binlog parsing, integrity checks, transaction assembly, and row images. |
| `pipa-store` | Atomic storage of connections, passwords, workspaces, query history, and MCP settings in SQLCipher SQLite. |
| `pipa-mysql` | MySQL connection tests, cancellable queries, batched results, and lossless value conversion built on SQLx. |
| `pipa-redis` | Redis connection tests, ACL authentication, database selection, and native commands through a bounded RESP codec. |
| `src-tauri` | Composition of local storage and adapters, Tauri IPC commands, and the local MCP service. |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before submitting an issue or pull request. The release and signing process is documented in [docs/RELEASING.md](docs/RELEASING.md).

Pipa was created by [Alasic333](https://github.com/AlasicPlat). Complete author and contributor attribution is recorded in [AUTHORS.md](AUTHORS.md) and the Git history.

## License

Pipa source code is licensed under the [Apache License 2.0](LICENSE). It permits use, modification, distribution, and commercial use while requiring preservation of the license and attribution notices. Contributions also receive the explicit patent grant in the license. Third-party components remain under their respective licenses; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for a summary.

More projects: [alasicplat.github.io](https://alasicplat.github.io)
