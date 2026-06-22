#!/usr/bin/env bash
# Entry-level tool check for scripts/codemod/*. Exits 1 with install hints if anything missing.
# Source: feat-20260511-engine-package-family-rename · M1 / w2 (charter command 4 explicit failure).
set -euo pipefail

missing=0

check() {
  local bin="$1"
  local hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[fatal] '$bin' not installed. Install via: $hint" >&2
    missing=1
  fi
}

check node "https://nodejs.org/ or pnpm via volta/asdf — version >=22 required (see package.json#engines)"
check jq "macOS: 'brew install jq'  ·  Ubuntu: 'sudo apt-get install -y jq'"
# rg (ripgrep) is intentionally NOT required here — neither rename-engine-family.sh
# nor its subscripts invoke it. The only consumer is scripts/codemod/verify-ac.sh,
# which carries its own rg preflight. Adding rg back here would force every CI
# codemod-idempotency run to install ripgrep just for an unused tool check.

# jscodeshift comes from node_modules/.bin (workspace devDep), not the PATH.
JSCODESHIFT_BIN="${JSCODESHIFT_BIN:-./node_modules/.bin/jscodeshift}"
if [ ! -x "$JSCODESHIFT_BIN" ]; then
  echo "[fatal] jscodeshift binary not found at '$JSCODESHIFT_BIN'." >&2
  echo "        Run 'pnpm install' at the repo root, or 'pnpm add -D -w jscodeshift @types/jscodeshift' if not yet declared." >&2
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo "[fatal] one or more tools missing. Aborting." >&2
  exit 1
fi

echo "[check-tools] OK — node $(node --version), jq $(jq --version)"
