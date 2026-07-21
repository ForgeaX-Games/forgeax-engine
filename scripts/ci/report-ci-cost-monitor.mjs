#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['scripts/ci/check-ci-cost-budget.mjs', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stdout.write(
    '::warning title=CI cost monitor::Budget violations were recorded in ci-cost-facts.json and the step summary.\n',
  );
}
