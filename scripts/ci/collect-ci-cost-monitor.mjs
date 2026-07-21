#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--out');
const output = outputIndex === -1 ? null : args[outputIndex + 1];
if (!output)
  throw new Error('Usage: collect-ci-cost-monitor.mjs --out <facts.json> [collect args]');

const result = spawnSync(process.execPath, ['scripts/ci/collect-ci-cost-facts.mjs', ...args], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) {
  writeFileSync(
    output,
    `${JSON.stringify({
      schemaVersion: 1,
      artifacts: [],
      consumers: [],
      cache: { activeBytes: null },
      ac06: { status: 'invalidEvidence', perConsumer: [] },
      sharedProduction: { status: 'invalidEvidence' },
      monitorFailure: { code: 'ci-cost-facts-unavailable', exitCode: result.status },
    })}\n`,
  );
  process.stdout.write(
    '::warning title=CI cost monitor::Cost facts were unavailable; invalid evidence was recorded without blocking CI.\n',
  );
}
