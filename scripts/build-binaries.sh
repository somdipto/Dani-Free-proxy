#!/usr/bin/env bash
# Build single-file dani-free executables (Bun runtime embedded; nothing to install).
# Output: dist/dani-free-<platform>-<arch>[.exe] plus SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "bun is required to build" >&2; exit 1; }
rm -rf dist && mkdir -p dist
targets=(
  "bun-darwin-x64:dani-free-darwin-x64"
  "bun-darwin-arm64:dani-free-darwin-arm64"
  "bun-linux-x64:dani-free-linux-x64"
  "bun-linux-arm64:dani-free-linux-arm64"
  "bun-windows-x64:dani-free-windows-x64.exe"
)
for entry in "${targets[@]}"; do
  target="${entry%%:*}"; out="${entry#*:}"
  echo "building $out ($target)"
  # Release builds hard-disable the development roster and debug logs (see src/opacity.ts).
  bun build src/cli.ts --compile --minify --sourcemap=none --define 'process.env.DANI_FREE_RELEASE="1"' --target="$target" --outfile "dist/$out"
done
( cd dist && { command -v sha256sum >/dev/null && sha256sum dani-free-* || shasum -a 256 dani-free-*; } > SHA256SUMS )
ls -la dist
