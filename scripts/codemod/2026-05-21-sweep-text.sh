#!/usr/bin/env bash
# sweep-text for feat-20260521-consolidate-apps-hello-namespace
#
# Five pattern classes, all using sd -F (literal) replacement:
#   P1: apps/hello- → apps/hello/
#   P2: apps/parity- → apps/parity/
#   P3: --filter (hello|parity)-  →  --filter @forgeax/(hello|parity)-
#   P4: .jscpd.json: apps/hello-*  →  apps/hello/*  (same for parity-)
#   P5: console markers [hello-X] → [X], [parity-X] → [X]
#
# Excluded (never modified):
#   - Other feat loop dirs (.forgeax-harness/forgeax-loop/ except current feat)
#   - .knowledge-base/sources/*
#   - 4 analysis wikis (forgeax-vs-threejs-gap, forgeax-rhi-shader-mvp-plan,
#     runtime-renderer-options-and-device-lifecycle, ecs-comparison)
#   - forgeax-engine-assets/**, pnpm-lock.yaml, bun.lock, node_modules/**
#
# Modes: --dry-run (stats-only) | --run (apply)

set -uo pipefail   # NOT -e: rg returns rc=1 on no-match which is benign here

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# ─── Exclusion globs ───
EXCLUDE=(
  -g '!**/.forgeax-harness/**'
  -g '!**/.knowledge-base/sources/**'
  -g '!**/.knowledge-base/wiki/forgeax-vs-threejs-gap.md'
  -g '!**/.knowledge-base/wiki/forgeax-rhi-shader-mvp-plan.md'
  -g '!**/.knowledge-base/wiki/runtime-renderer-options-and-device-lifecycle.md'
  -g '!**/.knowledge-base/wiki/ecs-comparison.md'
  -g '!**/forgeax-engine-assets/**'
  -g '!pnpm-lock.yaml'
  -g '!bun.lock'
  -g '!node_modules/**'
  -g '!scripts/codemod/2026-05-21-sweep-text.sh'
  -g '!scripts/codemod/README.md'
)

# ─── Usage ───
usage() {
  cat <<'EOF'
Usage: 2026-05-21-sweep-text.sh [--dry-run | --run]

  --dry-run   Print per-pattern file counts + line counts (no writes)
  --run       Apply P1-P5 replacements in-place
EOF
  exit 1
}

# ─── Stats helper (used by dry-run) ───
print_stats() {
  echo ""
  echo "=== Dry-Run Hit Counts ==="
  echo "Pattern          | Lines | Files"
  echo "---------------- | ----- | -----"

  local out lines files
  # P1
  out=$(rg -c -F 'apps/hello-' "${EXCLUDE[@]}" . 2>/dev/null || true)
  lines=$(echo "$out" | awk -F: '{s+=$2; f++} END {printf "%d", s}')
  files=$(echo "$out" | awk -F: '{f++} END {printf "%d", f}')
  printf "%-16s | %5s | %5s\n" "P1 apps/hello-" "$lines" "$files"

  # P2
  out=$(rg -c -F 'apps/parity-' "${EXCLUDE[@]}" . 2>/dev/null || true)
  lines=$(echo "$out" | awk -F: '{s+=$2; f++} END {printf "%d", s}')
  files=$(echo "$out" | awk -F: '{f++} END {printf "%d", f}')
  printf "%-16s | %5s | %5s\n" "P2 apps/parity-" "$lines" "$files"

  # P3
  out=$(rg -c -- '--filter (hello-|parity-)' "${EXCLUDE[@]}" . 2>/dev/null || true)
  lines=$(echo "$out" | awk -F: '{s+=$2; f++} END {printf "%d", s}')
  files=$(echo "$out" | awk -F: '{f++} END {printf "%d", f}')
  printf "%-16s | %5s | %5s\n" "P3 --filter X-" "$lines" "$files"

  # P4
  out=$(rg -c -F 'apps/hello-' .jscpd.json -H 2>/dev/null || true)
  lines=$(echo "$out" | awk -F: '{s+=$2} END {printf "%d", s}')
  printf "%-16s | %5s | %5s\n" "P4 .jscpd.json" "$lines" "1"

  # P5
  out=$(rg -c -F '[hello-' apps/hello/*/src/main.ts apps/parity/*/src/main.ts 2>/dev/null || true)
  lines=$(echo "$out" | awk -F: '{s+=$2; f++} END {printf "%d", s}')
  files=$(echo "$out" | awk -F: '{f++} END {printf "%d", f}')
  printf "%-16s | %5s | %5s\n" "P5 markers" "$lines" "$files"

  echo ""
  echo "Protected (excluded): .forgeax-harness/**, .knowledge-base/sources/**,"
  echo "  4 analysis wikis, forgeax-engine-assets/**, lockfiles, node_modules/"
}

# ─── Run helpers ───
run_p1p2() {
  echo "P1: apps/hello- → apps/hello/"
  rg --hidden -l -F 'apps/hello-' "${EXCLUDE[@]}" . 2>/dev/null | sort | while IFS= read -r f; do
    sd -F 'apps/hello-' 'apps/hello/' "$f"
  done

  echo "P2: apps/parity- → apps/parity/"
  rg --hidden -l -F 'apps/parity-' "${EXCLUDE[@]}" . 2>/dev/null | sort | while IFS= read -r f; do
    sd -F 'apps/parity-' 'apps/parity/' "$f"
  done
}

run_p3() {
  echo "P3: --filter X-Y → --filter @forgeax/X-Y (X=hello|parity)"
  rg --hidden -l "${EXCLUDE[@]}" -e '--filter (hello|parity)-' . 2>/dev/null | sort | while IFS= read -r f; do
    sd -- '--filter (hello|parity)-' '--filter @forgeax/$1-' "$f"
  done
}

run_p4() {
  echo "P4: .jscpd.json"
  sd -F 'apps/hello-' 'apps/hello/' .jscpd.json 2>/dev/null || true
  sd -F 'apps/parity-' 'apps/parity/' .jscpd.json 2>/dev/null || true
}

run_p5() {
  echo "P5: console markers"
  for demo_dir in apps/hello/*/ apps/parity/*/; do
    local short prefix marker_old
    short=$(basename "$demo_dir")
    if [[ "$demo_dir" == apps/hello/*/ ]]; then
      prefix="hello"
    else
      prefix="parity"
    fi
    marker_old="[$prefix-$short]"
    if [[ -f "${demo_dir}src/main.ts" ]]; then
      sd -F "$marker_old" "[$short]" "${demo_dir}src/main.ts" 2>/dev/null || true
    fi
  done
}

# ─── Main ───
case "${1:-}" in
  --dry-run)
    print_stats
    ;;
  --run)
    run_p1p2
    run_p3
    run_p4
    run_p5
    echo ""
    echo "All P1-P5 replacements applied."
    echo "Verify with: rg -F 'apps/hello-' -g '!**/.forgeax-harness/**' ."
    ;;
  *)
    usage
    ;;
esac