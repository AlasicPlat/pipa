# Security policy

## Supported versions

Security fixes are provided for the latest published Pipa release. Users should update to the newest version shown on the [Releases page](https://github.com/AlasicPlat/pipa/releases/latest).

## Report a vulnerability

Please use GitHub's private vulnerability reporting entry under the repository **Security** tab. Include the affected version, macOS architecture, impact, reproduction steps and any minimal proof of concept.

Do not open a public Issue containing credentials, connection strings, database contents, updater or Apple signing material, MCP bearer tokens, or an unpatched exploit. If private vulnerability reporting is temporarily unavailable, contact [@AlasicPlat](https://github.com/AlasicPlat) privately before sharing sensitive details.

You should receive an acknowledgement within seven days. The maintainer will validate the report, coordinate a fix and disclosure timeline, and credit the reporter unless anonymity is requested.

## Security model

- Pipa is local-first but may connect to user-configured databases and GitHub Releases for signed updates.
- MCP binds only to the loopback interface and requires a rotatable bearer token.
- Connection data is held in a SQLCipher database. The bootstrap key resides in the same private application data directory, so Pipa does not claim protection from another process that can read that entire directory.
- Query results and Binlog analyses remain in process memory and are not persisted by default.
- Update archives must pass Tauri signature verification; macOS distributions are also Developer ID signed and notarized.

Operational details and dependency risk acceptances are documented under `docs/security/`.
