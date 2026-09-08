import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWithRetry } from '../retry-until-pass.mjs';

test('runWithRetry retries an explicitly retryable browser-process failure', async () => {
  let attempts = 0;
  const result = await runWithRetry(
    async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, summary: 'wasm process crash', retryable: true }
        : { ok: true, summary: 'fresh process passed' };
    },
    { maxAttempts: 3, label: 'retryable' },
  );

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
});

test('runWithRetry does not repeat a deterministic gate failure', async () => {
  let attempts = 0;
  const result = await runWithRetry(
    async () => {
      attempts += 1;
      return { ok: false, summary: 'all-black canvas', retryable: false };
    },
    { maxAttempts: 3, label: 'deterministic' },
  );

  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
});
