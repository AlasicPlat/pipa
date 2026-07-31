# Local data threat model

Pipa protects database credentials and workspace data against accidental disclosure and inspection of the main database file in isolation. It does not claim to isolate data from another process already running as the same operating-system user with permission to read Pipa's entire application data directory.

## Protected assets

- database connection profiles and passwords;
- saved workspace SQL/commands and query history;
- MCP settings and pending review state;
- in-memory query results and Binlog analyses;
- updater and Apple release-signing integrity.

## Trust boundaries

- `pipa-data.db` is encrypted with SQLCipher.
- Its randomly generated root key is stored in `pipa-bootstrap.db` in the same private application data directory. The directory is restricted to `0700` and files to `0600` where the platform permits.
- This separation prevents a copied main database file from being read by itself. Copying the whole application directory under the same user's authority also copies the key and is outside this protection boundary.
- UI preferences such as theme, shortcuts and sidebar layout may use WebView `localStorage`; credentials, SQL, query history and results do not.
- Query results and Binlog analyses are process-memory state. Switching workspaces retains them for the running session; process exit discards them.
- MCP listens on loopback, authenticates each request with a random bearer token and applies connection scope plus SQL risk controls. Other same-user processes can still attempt to reach loopback and must possess the token.
- GitHub Releases is the only product-managed external update service. Tauri signatures authenticate update archives, while Apple Developer ID signing and notarization authenticate macOS distribution.

## User mitigations

Use FileVault or equivalent full-disk encryption, protect the macOS account, keep database TLS enabled on untrusted networks, rotate MCP tokens after exposure, and install updates only through Pipa or the canonical GitHub Releases page.
