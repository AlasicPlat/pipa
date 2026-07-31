# Release guide

Pipa uses one canonical repository, [`AlasicPlat/pipa`](https://github.com/AlasicPlat/pipa), for source, Issues, tags and GitHub Releases. Releases are built by GitHub Actions from protected `vX.Y.Z` tags; maintainers must not upload an unsigned replacement asset under an existing tag.

## Signing boundary

Pipa uses two independent signing systems:

- Apple Developer ID signing and notarization establish macOS trust for the application and DMG.
- Tauri Updater signing authenticates `.app.tar.gz` update archives against the public key embedded in `src-tauri/tauri.conf.json`.

The Apple certificate, its password, notarization credentials and the Tauri updater private key are secrets. Keep them in GitHub Actions encrypted secrets and in an access-controlled offline backup. Only the updater public key belongs in Git.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application certificate bundle |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate bundle |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity selected during signing |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_PASSWORD` | App-specific Apple password |
| `APPLE_TEAM_ID` | Apple Developer team identifier |
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of the Tauri updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password, when the key is encrypted |

Never print secret values in logs, place them in a repository directory, attach them to a Release or pass them to workflows triggered by untrusted pull requests.

## Prepare a release

1. Confirm CI is green on `main` and there are no unresolved high-severity security findings.
2. Run `./scripts/verify-foundation.sh` on a trusted macOS development machine.
3. Update the same semantic version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then refresh lockfiles.
4. Add user-facing release notes to the release commit or draft them before tagging.
5. Merge the version commit into protected `main`.

Create and push an annotated tag only from the reviewed `main` commit:

```bash
git tag -a "vX.Y.Z" -m "Pipa vX.Y.Z"
git push origin "vX.Y.Z"
```

The release workflow builds Apple Silicon and Intel packages, signs and notarizes them, emits Tauri updater archives and signatures, uploads a shared `latest.json`, and creates a draft GitHub Release. Draft status permits a maintainer to verify assets before they become the updater's `latest` endpoint.

## Verify the draft

Before publishing, confirm all of the following:

- `Pipa-macOS-arm64.dmg` contains an `arm64` executable.
- `Pipa-macOS-x64.dmg` contains an `x86_64` executable.
- Both DMGs pass `codesign --verify`, `spctl` Gatekeeper assessment and notarization stapler validation.
- Both `.app.tar.gz` archives have matching `.sig` files.
- `latest.json` references the tagged version, both macOS targets and the correct GitHub Release assets.
- A previously released build detects the draft through a temporary test endpoint or pre-release channel, rejects a deliberately invalid signature, installs the valid package and restarts without losing persisted workspace data.

Once verified, publish the draft and confirm these stable links return the expected files:

```text
https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-arm64.dmg
https://github.com/AlasicPlat/pipa/releases/latest/download/Pipa-macOS-x64.dmg
https://github.com/AlasicPlat/pipa/releases/latest/download/latest.json
```

Do not delete or replace a published tag. If a release is faulty, publish a higher patch version so updater signatures, Git history and user installations remain auditable.

## Rotate an updater key

Losing the updater private key prevents existing clients from accepting future updates. If compromise is suspected, stop publishing, preserve evidence and ship a normally Apple-signed bridge release whose application configuration trusts the replacement public key. Users unable to install that bridge version must update manually. Record the rotation in release notes and `SECURITY.md`.
