#!/usr/bin/env node
// AC-12 grep gate: assert packages/console/README.md contains the 5 locked
// H2 section heading literals defined by feat-20260513 plan-strategy round
// 2 (unified abstraction path) + plan-tasks.json w6/w7 single-source lock-in
// (PlanReviewer round 1 F-2 carries through the round 2 rewrite).
//
// Locked literals (closed set, 5; character-exact match including spaces /
// punctuation / non-ASCII / brackets). Strings stored as Unicode escape
// sequences so the script source remains ASCII-only (engine english-only
// gate); runtime characters are unchanged.
//
// Both this script and packages/console/README.md derive from the same
// plan-strategy round 2 D-7 / plan-tasks.json w6+w7 notes block; the literals
// MUST stay byte-for-byte aligned (rename one side without the other = CI red).
//
// Pattern aligns with sibling console gates (check-no-string-sugar.mjs etc):
// zero npm deps, plain `node:fs` + `node:path`, exit 1 on any miss. Walks
// only the single README target - recursion is unnecessary.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REQUIRED_HEADINGS = [
  '## \u5305\u5B9A\u4F4D',
  '## CLI \u5B50\u547D\u4EE4',
  '## \u7EDF\u4E00\u62BD\u8C61\uFF1ACLI ecs plugin\uFF08\u4E0D\u6D89\u53CA\u4EE3\u7801\uFF09+ script raw \u901A\u9053\uFF08\u6D89\u53CA\u4EE3\u7801\u81EA\u5199 .ts + tsc\uFF09',
  '## \u95ED\u96C6 6 \u6210\u5458\u9519\u8BEF\u7801\u6D88\u8D39\u793A\u4F8B',
  '## ECS schedule \u901F\u67E5\uFF08\u7528\u6237\u5728 .ts \u5185\u53EF\u8C03\u7528\uFF09',
];

const README = join(process.cwd(), 'packages', 'console', 'README.md');

function main() {
  let text;
  try {
    text = readFileSync(README, 'utf8');
  } catch (e) {
    process.stderr.write(
      `[fail] AC-12: cannot read ${README}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }

  // Split on newline so a heading literal must appear as a full line; this
  // prevents an inline mention inside a paragraph from accidentally
  // satisfying the gate.
  const lines = text.split(/\r?\n/);
  const lineSet = new Set(lines);

  const missing = [];
  for (const h of REQUIRED_HEADINGS) {
    if (!lineSet.has(h)) missing.push(h);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `[fail] AC-12: packages/console/README.md missing ${missing.length} required H2 heading(s):\n`,
    );
    for (const h of missing) {
      process.stderr.write(`  ${h}\n`);
    }
    process.stderr.write(
      `\n  expected: each literal appears on its own line (character-exact)\n` +
        `  hint:     update README.md AND scripts/check-readme-sections.mjs together (single-source lock-in, plan-review round 1 F-2)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[ok] AC-12: packages/console/README.md contains all 5 locked H2 headings\n`,
  );
}

main();
