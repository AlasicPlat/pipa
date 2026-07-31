#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# 停止里程碑测试数据库，同时保留验证命令的退出状态。
# 参数：无。返回：验证失败时返回验证状态；验证成功后返回清理状态。
# 副作用：停止并移除本脚本创建的 Compose 服务和项目网络。
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
pnpm licenses:check
pnpm test
pnpm build
cargo fmt --all -- --check
cargo test --workspace
pnpm bindings:format
git diff --exit-code -- src/bindings
cargo clippy --workspace --all-targets -- -D warnings
./scripts/audit-rust.sh
pnpm tauri build --debug
