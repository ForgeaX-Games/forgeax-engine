import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectRunnerPause } from '../../../apps/hello/multithreaded-execution/scripts/benchmark-statistics.mjs';
import { isRetryableOutput } from '../run-browser-gate-with-retry.mjs';

test('Vitest retries only declared browser-runner instability markers', () => {
  assert.equal(
    isRetryableOutput(
      'vitest',
      '[learn-render] bootstrap inconclusive within 60s (no SUT error, not complete); -> runner instability, rerun',
    ),
    true,
  );
  assert.equal(isRetryableOutput('vitest', 'AssertionError: expected 1 to be 2'), false);
  assert.equal(isRetryableOutput('vitest', 'Browser connection was closed'), true);
  assert.equal(
    isRetryableOutput(
      'vitest',
      'ForgeaX linear HDR observation failed: readback-failed (A valid external Instance reference no longer exists.)',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'Error: ForgeaX linear HDR observation failed: observation-unavailable',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'vitest',
      'apps/learn-render/5.advanced-lighting/5.parallax-mapping/src/__tests__/onerror-gate.browser.test.ts\n' +
        'Error: Test timed out in 60000ms.',
    ),
    false,
  );
});

test('RHI-debug retries only bounded external capture instability markers', () => {
  assert.equal(
    isRetryableOutput(
      'rhi-debug',
      'capture off failed before materializing v7 tape: {"ok":false,"error":{"code":"capture-timeout"}}',
    ),
    true,
  );
  assert.equal(isRetryableOutput('rhi-debug', 'AssertionError: paired captures differ'), false);
});

test('the production benchmark retries only declared runner instability', () => {
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] runner pause detected; runner instability: [{"tier":"shared"}]',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness timeout; runner instability: {"tier":"engine-worker"}',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness failed: {"diagnostic":{"report":{"fault":{"detail":{"phase":"frame"}}},"pageErrors":[]}}',
    ),
    true,
  );
  assert.equal(
    isRetryableOutput(
      'benchmark',
      '[multithreaded benchmark] browser readiness failed: {"diagnostic":{"report":{"fault":{"detail":{"phase":"frame"}}},"pageErrors":["page error"]}}',
    ),
    false,
  );
  assert.equal(
    isRetryableOutput('benchmark', '[multithreaded benchmark] performance verdict failed'),
    false,
  );
  assert.equal(isRetryableOutput('benchmark', 'shared page errors: device lost'), false);
});

test('runner pause detection isolates host spikes without masking sustained slowness', () => {
  const stable = detectRunnerPause(Array.from({ length: 240 }, () => 20));
  assert.equal(stable.detected, false);

  const isolated = detectRunnerPause([1000, ...Array.from({ length: 239 }, () => 20)]);
  assert.equal(isolated.detected, true);
  assert.equal(isolated.maximumMs, 1000);

  const sustained = detectRunnerPause(Array.from({ length: 240 }, () => 300));
  assert.equal(sustained.detected, false);
});
