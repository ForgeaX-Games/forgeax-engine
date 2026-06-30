#!/usr/bin/env node
// AC-08 grep gate: assert the legacy `buildHelpText` / `buildInspectHelpText`
// string-array helpers are decommissioned from `packages/remote/src/cli.ts`.
//
// The cli.ts help body is now produced by the package-internal
// `defineSubcommand` DSL (plan-strategy D-4 + D-7 lock-in); the legacy
// string-array constants were removed as part of M4 w17. Hits in cli.ts
// (production source — comments excluded by the function-definition regex
// below) indicate the migration backslid.
//
// Pattern aligns with `check-no-string-sugar.mjs`: zero npm deps, plain
// `node:fs`, exit 1 on any hit. Scope is cli.ts only — test fixtures may
// reference the legacy names as anti-regression anchors (test-side wrappers
// around `renderHelp(...)` keep the same names as inline aliases so existing
// test bodies stay reusable; that is intentional and is not a backslide).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Match the function-definition shape only:
//   function buildHelpText() { return [ ... ].join(...); }
//   const buildHelpText = (): string => [ ... ].join(...);
//   export function buildInspectHelpText(): string { return [ ... ].join('\n'); }
const FORBIDDEN_DEFS = [
  /\bfunction\s+buildHelpText\b/,
  /\bfunction\s+buildInspectHelpText\b/,
  /\bconst\s+buildHelpText\s*[:=]/,
  /\bconst\s+buildInspectHelpText\s*[:=]/,
];

const CLI_PATH = join(process.cwd(), 'packages', 'remote', 'src', 'cli.ts');

function main() {
  const text = readFileSync(CLI_PATH, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip line comments — comments may keep the legacy names as historical
    // anchors (the cli.ts top banner explicitly references the
    // decommissioned helpers so AI users can grep the migration history).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    for (const re of FORBIDDEN_DEFS) {
      if (re.test(line)) {
        hits.push({ line: i + 1, content: line.trim() });
      }
    }
  }
  if (hits.length > 0) {
    process.stderr.write(
      `[fail] AC-08: legacy buildHelpText / buildInspectHelpText function definition hits in packages/remote/src/cli.ts:\n`,
    );
    for (const h of hits) {
      process.stderr.write(`  ${CLI_PATH}:${h.line}  ${h.content}\n`);
    }
    process.stderr.write(
      `\n  expected: 0 hits in packages/remote/src/cli.ts production source\n` +
        `  hint:     migrate to renderHelp(FORGEAX_CLI_SPEC, path) from ./defineSubcommand\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `[ok] AC-08: 0 hits for legacy buildHelpText / buildInspectHelpText function definitions in cli.ts\n`,
  );
}

main();
