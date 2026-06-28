#!/usr/bin/env node
// check_state_doc_sync.mjs — AC-19 gate: verify all 11 doc items from M8 m8w1
// contain expected key anchors.
//
// Usage: node scripts/forgeax/check_state_doc_sync.mjs [REPO_ROOT]
//   REPO_ROOT defaults to `git rev-parse --show-toplevel`.
//   Exit 0 if all 11 items contain expected anchors.
//   Exit 1 with per-item report if any item is missing.
//
// Created: feat-20260616-engine-state-and-state-scoped-entities M8 / m8w2
// Cross-platform: pure Node fs reads (no system grep) — runs on Windows dev box.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT =
  process.argv[2] ?? execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

const HARNESS_DIR = join(REPO_ROOT, '.forgeax-harness');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const RULES_DIR = join(REPO_ROOT, 'rules');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const FEATURE_ID = 'feat-20260616-engine-state-and-state-scoped-entities';

let failures = 0;
let total = 0;

/** Read a file, returning '' if it does not exist (mirrors `grep -q ... 2>/dev/null`). */
function readOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Pass if the file contains ANY of the given anchors (substring match). */
function checkItemAny(label, file, ...anchors) {
  total++;
  const content = readOrEmpty(file);
  const found = anchors.find((a) => content.includes(a));
  if (found !== undefined) {
    console.log(`  PASS  ${label}: ${file} (${found})`);
    return;
  }
  console.log(`  FAIL  ${label}: ${file} — missing ALL anchors: ${anchors.join(' ')}`);
  failures++;
}

console.log('=== check_state_doc_sync: verifying 11-item M8 documentation coverage ===');
console.log('');

// (1) skills/forgeax-engine-state/SKILL.md — SSOT for @forgeax/engine-state usage
checkItemAny(
  'item-01 state-skill',
  join(SKILLS_DIR, 'forgeax-engine-state/SKILL.md'),
  'forgeax-engine-state',
);

// (2) rules/forgeax-engine-usage.md — state-machine task routing
checkItemAny(
  'item-02 usage-routing',
  join(RULES_DIR, 'forgeax-engine-usage.md'),
  'forgeax-engine-state',
);

// (3) AGENTS.md — @forgeax/engine-state listed in Packages
checkItemAny('item-03 agents-packages', join(REPO_ROOT, 'AGENTS.md'), '@forgeax/engine-state');

// (4) skills/forgeax-engine-app/SKILL.md — createApp auto-registers state plugin
checkItemAny(
  'item-04 app-skill',
  join(SKILLS_DIR, 'forgeax-engine-app/SKILL.md'),
  'registerStatesPlugin',
);

// (5) skills/forgeax-engine-cli/SKILL.md — forgeax-engine-console-state plugin
checkItemAny(
  'item-05 cli-skill',
  join(SKILLS_DIR, 'forgeax-engine-cli/SKILL.md'),
  'forgeax-engine-console-state',
);

// (6) packages/state/README.md — SSOT for state package API
checkItemAny(
  'item-06 state-readme',
  join(PACKAGES_DIR, 'state/README.md'),
  'defineState',
  'setNextState',
  'StateErrorCode',
);

// (7) skills/forgeax-engine-ecs/SKILL.md — zero-intrusion design note
checkItemAny(
  'item-07 ecs-skill',
  join(SKILLS_DIR, 'forgeax-engine-ecs/SKILL.md'),
  'zero-intrusion',
  'state-machine integration',
  '@forgeax/engine-state',
);

// (8) docs/roadmaps/2026-06-15-game-demo-engine-gaps.md — state-machine gap resolved
checkItemAny(
  'item-08 roadmap',
  join(DOCS_DIR, 'roadmaps/2026-06-15-game-demo-engine-gaps.md'),
  '2026-06-17 update',
  FEATURE_ID,
  '@forgeax/engine-state',
);

// (9) .forgeax-harness/knowledge-base/wiki/bevy-state-and-state-scoped-entities.md
checkItemAny(
  'item-09 bevy-wiki',
  join(HARNESS_DIR, 'knowledge-base/wiki/bevy-state-and-state-scoped-entities.md'),
  FEATURE_ID,
);

// (10) docs/how-to/2026-06-17-state-machine-and-scoped-entities.md — how-to with full example
checkItemAny(
  'item-10 how-to',
  join(DOCS_DIR, 'how-to/2026-06-17-state-machine-and-scoped-entities.md'),
  'defineState',
  'setNextState',
);

// (11) packages/runtime/README.md — linkedSpawn default change
checkItemAny('item-11 runtime-readme', join(PACKAGES_DIR, 'runtime/README.md'), 'linkedSpawn');

console.log('');
console.log(`=== Result: ${total - failures} / ${total} passed ===`);

if (failures > 0) {
  console.log('');
  console.log(`ERROR: ${failures} item(s) missing expected anchors.`);
  console.log('Check the per-item FAIL lines above for the specific file and anchor.');
  process.exit(1);
}

console.log('All 11 items contain expected anchors.');
process.exit(0);
