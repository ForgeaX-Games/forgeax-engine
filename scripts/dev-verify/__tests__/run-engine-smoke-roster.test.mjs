import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SMOKE_MIN_FRAMES } from '../../ci/run-dawn-smoke-roster.mjs';
import { discoverSmokeApps } from '../run-engine-smoke-roster.mjs';

test('dynamic engine smoke roster discovers hello and learn-render apps from smoke metadata', () => {
  const roster = discoverSmokeApps(process.cwd());
  assert.equal(
    roster.some((app) => app.name === '@forgeax/hello-deep-agent-feedback'),
    true,
  );
  assert.equal(
    roster.every((app) => app.invocation.startsWith('pnpm --filter ')),
    true,
  );
});

for (const requested of [undefined, '300'])
  test(`local roster propagates ${requested ?? 'default 60'} frames`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-smoke-env-'));
    try {
      writeFileSync(
        join(directory, 'pnpm'),
        '#!/bin/sh\ntest "$SMOKE_MIN_FRAMES" = "$EXPECTED_SMOKE_MIN_FRAMES"\n',
        {
          mode: 0o755,
        },
      );
      const output = execFileSync(
        process.execPath,
        ['scripts/dev-verify/run-engine-smoke-roster.mjs'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            EXPECTED_SMOKE_MIN_FRAMES: requested ?? String(SMOKE_MIN_FRAMES),
            SMOKE_MIN_FRAMES: requested,
          },
          timeout: 30_000,
        },
      );
      const report = JSON.parse(output.trim());
      assert.equal(report.status, 'pass');
      assert.equal(report.count, discoverSmokeApps(process.cwd()).length);
      assert.deepEqual(report.failures, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('local roster rejects invalid requests before invoking an owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-smoke-invalid-'));
  const marker = join(directory, 'owner-invoked');
  try {
    writeFileSync(
      join(directory, 'pnpm'),
      '#!/bin/sh\necho unexpected > "$SMOKE_INVOCATION_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    for (const value of ['1', '59', '300x', '300.5', ''])
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ['scripts/dev-verify/run-engine-smoke-roster.mjs', '--list', '--frames', value],
            {
              stdio: 'pipe',
              env: {
                ...process.env,
                PATH: `${directory}:${process.env.PATH}`,
                SMOKE_INVOCATION_MARKER: marker,
                SMOKE_MIN_FRAMES: undefined,
              },
              timeout: 10_000,
            },
          ),
        /frame|integer|budget/i,
      );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
