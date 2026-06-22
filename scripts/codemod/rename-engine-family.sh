#!/usr/bin/env bash
# scripts/codemod/rename-engine-family.sh — atomic codemod entrypoint.
#
# Runs phases in order:
#   tools   tool availability check (node + jq + rg + jscodeshift)
#   A       packages/*/package.json + apps/*/package.json + templates/*/package.json (name, deps, description, console bin)
#   E       tsconfig*.json references (drop ./packages/core)
#   G       packages/engine/ placeholder takeover (git mv to packages/engine-runtime/, write placeholder pkg.json + README)
#   B       TS/JS imports via jscodeshift (AST literal equality)
#   C+D     non-import textual sweeps via Node (TS/JS strings, MD, YAML, JSON.description) with look-ahead R-3 protection
#   H       dual-lockfile regen — `bun install --ignore-scripts` (pnpm-lock.yaml is regenerated implicitly
#           by `pnpm install` during Phase A package.json rewrites; bun.lock needs an explicit pass).
#           Charter dual-lockfile rule: `pnpm-lock.yaml` + `bun.lock` both committed.
#           Skip via SKIP_BUN_INSTALL=1 (CI matrix already runs bun separately).
#
# Idempotent: re-running on a clean tree should produce zero diff (AC-16).
# Charter command-4 explicit failure: set -euo pipefail; each phase logs
# [phase X start] / [phase X done] / [phase X fail] to stderr.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

phase() { echo "[phase $1] $2" >&2 ; }

phase tools start
bash scripts/codemod/check-tools.sh
phase tools done

phase A start
node scripts/codemod/rename-package-json.mjs
phase A done

phase E start
node scripts/codemod/rename-tsconfig.mjs
phase E done

phase G start
node scripts/codemod/rename-placeholder.mjs
phase G done

phase B start
node_modules/.bin/jscodeshift \
  --parser=ts \
  --extensions=ts,tsx,mts,cts,mjs,cjs,js,jsx \
  --fail-on-error \
  --ignore-pattern='**/dist/**' \
  --ignore-pattern='**/node_modules/**' \
  --ignore-pattern='**/coverage/**' \
  --ignore-pattern='**/*-progress.jsonl' \
  --ignore-pattern='.forgeax-harness/forgeax-loop/**' \
  --ignore-pattern='.knowledge-base/sources/**' \
  --ignore-pattern='packages/wgpu-wasm/pkg/**' \
  --ignore-pattern='**/pkg/**.wasm.d.ts' \
  -t scripts/codemod/transforms/rename-imports.cjs \
  packages apps scripts templates
phase B done

phase 'C+D' start
node scripts/codemod/rename-non-imports.mjs
phase 'C+D' done

phase H start
if [ "${SKIP_BUN_INSTALL:-0}" = "1" ]; then
  echo "[phase H] SKIP_BUN_INSTALL=1 — bun.lock regen skipped" >&2
elif command -v bun >/dev/null 2>&1; then
  bun install --ignore-scripts
else
  echo "[phase H] bun not on PATH — install bun (https://bun.sh) and re-run, or set SKIP_BUN_INSTALL=1" >&2
  exit 1
fi
phase H done

echo "[rename-engine-family] all phases complete"
