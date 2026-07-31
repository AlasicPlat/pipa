#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

# cargo-audit evaluates every package in Cargo.lock even when target filters are supplied. Verify
# explicitly that Linux-only quick-xml/GTK advisories cannot enter either supported macOS graph.
for product_target in aarch64-apple-darwin x86_64-apple-darwin; do
  if cargo tree --locked --target "$product_target" | rg -q 'quick-xml v0\.39\.4|glib v0\.18\.5'; then
    echo "Unsupported vulnerable dependency entered the $product_target product graph" >&2
    exit 1
  fi
done

# The complete lockfile check prevents a future platform expansion from silently inheriting risk.
# Every ignored vulnerability has an owner, reachability analysis and expiry in the linked document.
cargo audit \
  --ignore RUSTSEC-2023-0071 \
  --ignore RUSTSEC-2026-0194 \
  --ignore RUSTSEC-2026-0195
