#!/usr/bin/env node
// Drift gate self-test harness (feat-20260512 M5 / w15 / AC-16).
//
// Invokes scripts/check-ci-channel-alignment.mjs in `--self-test` mode and
// asserts the three-state fixture contract:
//   (1) aligned primary-pnpm ↔ portability-bun → exit 0
//   (2) missing-in-portability                 → exit != 0  + stderr contains the missing step name
//   (3) primary-only allowlist                 → exit 0
//
// The fixtures live inside the script itself (`--self-test` reads inline YAML
// strings rather than disk files) so this harness only orchestrates the
// child-process invocations. Zero npm deps; stdlib only.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'check-ci-channel-alignment.mjs');

let failures = 0;
function assertEq(label, actual, expected) {
  if (actual === expected) {
    process.stdout.write(`  ok ${label}: ${actual}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${label}: expected ${expected}, got ${actual}\n`);
  }
}
function assertIncludes(label, haystack, needle) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    process.stdout.write(`  ok ${label}: stderr contains ${JSON.stringify(needle)}\n`);
  } else {
    failures += 1;
    process.stdout.write(
      `  FAIL ${label}: stderr missing ${JSON.stringify(needle)}\n--- stderr ---\n${haystack}\n--- end ---\n`,
    );
  }
}

process.stdout.write('check-ci-channel-alignment self-test harness\n');

const r = spawnSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' });
process.stdout.write(
  `exit=${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`,
);

// The script's --self-test must run all three internal cases and exit 0 if all pass,
// printing a final summary line. The harness checks the summary exit + that the
// stderr/stdout mention each case label.
assertEq('self-test exit code', r.status, 0);
assertIncludes('case aligned mentioned', r.stdout, 'case=aligned');
assertIncludes('case missing-in-portability mentioned', r.stdout, 'case=missing-in-portability');
assertIncludes('case primary-only-allowlist mentioned', r.stdout, 'case=primary-only-allowlist');

if (failures > 0) {
  process.stderr.write(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nall assertions passed\n');
