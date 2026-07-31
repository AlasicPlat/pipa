# Dependency security exceptions

Owner: [@AlasicPlat](https://github.com/AlasicPlat)

Next mandatory review: **2026-10-31**, and before every public release.

`scripts/audit-rust.sh` runs one macOS product-graph audit and one complete lockfile audit. A listed exception is not a claim that the advisory is false; it is a time-bounded reachability decision. New vulnerability IDs still fail CI automatically.

## RUSTSEC-2026-0194 and RUSTSEC-2026-0195 — quick-xml 0.39.4

- Status: accepted for the cross-platform lockfile only through 2026-10-31.
- Path: `tauri-plugin-clipboard-manager -> arboard -> wl-clipboard-rs -> wayland-scanner -> quick-xml`.
- Reachability: the affected parser is a Linux Wayland build-time/proc-macro dependency. It is absent from the supported Apple Silicon and Intel macOS runtime graphs, and Pipa does not pass user XML to it.
- Upstream constraint: `wayland-scanner 0.31.10` requires `quick-xml = "0.39"`; the patched parser begins at 0.41.
- Exit condition: update the Tauri clipboard/Wayland chain when it accepts quick-xml 0.41+, or remove the exception before any Linux release.

## RUSTSEC-2023-0071 — rsa 0.10.0-rc.18

- Status: accepted for the current MySQL authentication path through 2026-10-31.
- Path: `pipa-mysql -> sqlx-mysql -> rsa`.
- Reachability: SQLx uses this dependency to encrypt a password with the MySQL server's public key when `caching_sha2_password` is negotiated without transport TLS. Pipa neither loads nor performs operations with an RSA private key, while the Marvin advisory concerns timing leakage from private-key operations.
- Mitigation: TLS modes remain available and should be required for untrusted networks. Pipa never exposes RSA private-key operations through IPC or MCP.
- Exit condition: adopt an upstream constant-time RSA release through SQLx, or require TLS and remove SQLx's `rsa` feature if product compatibility permits.

## Informational Linux warnings

The complete lockfile currently includes unmaintained GTK3 bindings and `RUSTSEC-2024-0429` for `glib 0.18.5` through Tauri's Linux WebKit/GTK graph. Pipa ships only macOS packages, so those crates are not compiled into the supported product. Informational warnings remain visible in CI rather than being globally suppressed. They must be resolved or separately re-reviewed before adding Linux as a supported target.

## Resolved during the 2026-07-31 review

- `RUSTSEC-2026-0221`: updated `event-listener` from 5.4.1 to patched 5.4.2 in `Cargo.lock`.
- The active macOS graph already uses patched `quick-xml 0.41`; only the Linux Wayland build chain retains 0.39.4.
