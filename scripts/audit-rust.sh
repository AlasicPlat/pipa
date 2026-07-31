#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# 即使提供目标过滤器，cargo-audit 仍会检查 Cargo.lock 中的所有包，因此这里显式确认
# 仅限 Linux 的 quick-xml/GTK 风险不会进入任一受支持的 macOS 依赖图。
for product_target in aarch64-apple-darwin x86_64-apple-darwin; do
  if cargo tree --locked --target "$product_target" | rg -q 'quick-xml v0\.39\.4|glib v0\.18\.5'; then
    echo "不受支持的脆弱依赖进入了 $product_target 产品依赖图" >&2
    exit 1
  fi
done

# 完整锁文件检查可防止未来扩展平台时静默继承风险。
# 每个忽略项都必须在关联文档中记录负责人、可达性分析和到期日。
cargo audit \
  --ignore RUSTSEC-2023-0071 \
  --ignore RUSTSEC-2026-0194 \
  --ignore RUSTSEC-2026-0195
