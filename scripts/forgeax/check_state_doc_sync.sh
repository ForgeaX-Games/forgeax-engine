#!/usr/bin/env bash
# check_state_doc_sync.sh — AC-19 gate: verify all 11 doc items from M8 m8w1
# contain expected key anchors.
#
# Usage: bash scripts/forgeax/check_state_doc_sync.sh [REPO_ROOT]
#   REPO_ROOT defaults to git rev-parse --show-toplevel.
#   Exit 0 if all 11 items contain expected anchors.
#   Exit 1 with per-item report if any item is missing.
#
# Created: feat-20260616-engine-state-and-state-scoped-entities M8 / m8w2

set -euo pipefail

REPO_ROOT="${1:-$(git rev-parse --show-toplevel)}"
HARNESS_DIR="${REPO_ROOT}/.forgeax-harness"
SKILLS_DIR="${REPO_ROOT}/skills"
RULES_DIR="${REPO_ROOT}/rules"
DOCS_DIR="${REPO_ROOT}/docs"
PACKAGES_DIR="${REPO_ROOT}/packages"
FEATURE_ID="feat-20260616-engine-state-and-state-scoped-entities"

FAILURES=0
TOTAL=0

# ─── helpers ──────────────────────────────────────────────────────────────────

check_item() {
  local label="$1"
  local file="$2"
  local anchor="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$anchor" "$file" 2>/dev/null; then
    echo "  PASS  $label: $file ($anchor)"
  else
    echo "  FAIL  $label: $file — missing anchor '$anchor'"
    FAILURES=$((FAILURES + 1))
  fi
}

check_item_any() {
  local label="$1"
  local file="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  for anchor in "$@"; do
    if grep -q "$anchor" "$file" 2>/dev/null; then
      echo "  PASS  $label: $file ($anchor)"
      return 0
    fi
  done
  echo "  FAIL  $label: $file — missing ALL anchors: $*"
  FAILURES=$((FAILURES + 1))
}

# ─── item checks ──────────────────────────────────────────────────────────────

echo "=== check_state_doc_sync: verifying 11-item M8 documentation coverage ==="
echo ""

# (1) skills/forgeax-engine-state/SKILL.md — SSOT for @forgeax/engine-state usage
check_item_any "item-01 state-skill" \
  "${SKILLS_DIR}/forgeax-engine-state/SKILL.md" \
  "forgeax-engine-state"

# (2) rules/forgeax-engine-usage.md — state-machine task routing
check_item_any "item-02 usage-routing" \
  "${RULES_DIR}/forgeax-engine-usage.md" \
  "forgeax-engine-state"

# (3) AGENTS.md — @forgeax/engine-state listed in Packages
check_item_any "item-03 agents-packages" \
  "${REPO_ROOT}/AGENTS.md" \
  "@forgeax/engine-state"

# (4) skills/forgeax-engine-app/SKILL.md — createApp auto-registers state plugin
check_item_any "item-04 app-skill" \
  "${SKILLS_DIR}/forgeax-engine-app/SKILL.md" \
  "registerStatesPlugin"

# (5) skills/forgeax-engine-cli/SKILL.md — forgeax-engine-console-state plugin
check_item_any "item-05 cli-skill" \
  "${SKILLS_DIR}/forgeax-engine-cli/SKILL.md" \
  "forgeax-engine-console-state"

# (6) packages/state/README.md — SSOT for state package API
check_item_any "item-06 state-readme" \
  "${PACKAGES_DIR}/state/README.md" \
  "defineState" \
  "setNextState" \
  "StateErrorCode"

# (7) skills/forgeax-engine-ecs/SKILL.md — zero-intrusion design note
check_item_any "item-07 ecs-skill" \
  "${SKILLS_DIR}/forgeax-engine-ecs/SKILL.md" \
  "zero-intrusion" \
  "state-machine integration" \
  "@forgeax/engine-state"

# (8) docs/roadmaps/2026-06-15-game-demo-engine-gaps.md — state-machine gap resolved
check_item_any "item-08 roadmap" \
  "${DOCS_DIR}/roadmaps/2026-06-15-game-demo-engine-gaps.md" \
  "2026-06-17 update" \
  "${FEATURE_ID}" \
  "@forgeax/engine-state"

# (9) .forgeax-harness/knowledge-base/wiki/bevy-state-and-state-scoped-entities.md
check_item_any "item-09 bevy-wiki" \
  "${HARNESS_DIR}/knowledge-base/wiki/bevy-state-and-state-scoped-entities.md" \
  "${FEATURE_ID}"

# (10) docs/how-to/2026-06-17-state-machine-and-scoped-entities.md — how-to with full example
check_item_any "item-10 how-to" \
  "${DOCS_DIR}/how-to/2026-06-17-state-machine-and-scoped-entities.md" \
  "defineState" \
  "setNextState"

# (11) packages/runtime/README.md — linkedSpawn default change
check_item_any "item-11 runtime-readme" \
  "${PACKAGES_DIR}/runtime/README.md" \
  "linkedSpawn"

# ─── report ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Result: $((TOTAL - FAILURES)) / $TOTAL passed ==="

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "ERROR: $FAILURES item(s) missing expected anchors."
  echo "Check the per-item FAIL lines above for the specific file and anchor."
  exit 1
fi

echo "All 11 items contain expected anchors."
exit 0