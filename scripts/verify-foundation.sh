#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# Stops the milestone database while preserving the verification command's exit status.
# Parameters: none. Returns: exits with the verification status, or the cleanup status after success.
# Side effects: stops and removes the Compose service and project network it created.
cleanup() {
  local verification_status=$?
  local cleanup_status

  trap - EXIT INT TERM
  set +e
  docker compose -f infra/test/mysql.compose.yml down
  cleanup_status=$?
  set -e

  if ((verification_status != 0)); then
    exit "$verification_status"
  fi

  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -f infra/test/mysql.compose.yml up -d --wait

pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm tauri build --debug
