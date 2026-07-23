import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureArtifactDestination,
  isRetryableTransportError,
  parseArtifactIds,
  RETRY_DELAYS_SECONDS,
  retryArtifact,
} from '../download-artifact-with-retry.mjs';

test('creates nested artifact destinations before extraction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-artifact-destination-'));
  const destination = join(root, 'shared-app-inputs', 'assets');
  try {
    await ensureArtifactDestination(destination);
    assert.equal(existsSync(destination), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retries only bounded artifact transport failures', () => {
  assert.deepEqual(RETRY_DELAYS_SECONDS, [0, 5, 15]);
  for (const message of [
    'read ECONNRESET',
    'Failed to GetSignedArtifactURL: request failed',
    'fetch failed: socket hang up',
    'HTTP 408 while reading artifact service',
    'HTTP 429 while reading artifact service',
    'HTTP 502 while reading artifact service',
    'HTTP 503 while reading artifact service',
  ]) {
    assert.equal(isRetryableTransportError(new Error(message)), true, message);
  }
  for (const message of [
    'HTTP 401 while reading artifact metadata',
    'HTTP 403 while downloading artifact',
    'HTTP 404 while reading artifact metadata',
    'HTTP 410 while downloading artifact',
    'artifact digest mismatch',
    'unzip failed',
  ]) {
    assert.equal(isRetryableTransportError(new Error(message)), false, message);
  }
});

test('requires non-empty numeric exact artifact IDs', () => {
  assert.deepEqual(parseArtifactIds('12, 34'), ['12', '34']);
  for (const value of ['', '12,,34', 'a12', '0', '-3']) {
    assert.throws(() => parseArtifactIds(value), /artifact IDs/);
  }
});

test('retries a simulated connection reset then returns the successful attempt', async () => {
  const delays = [];
  const retries = [];
  let calls = 0;
  const result = await retryArtifact(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return 'hydrated';
    },
    {
      sleepFn: async (seconds) => delays.push(seconds),
      onRetry: async ({ attempt }) => retries.push(attempt),
    },
  );
  assert.deepEqual(result, { attempt: 3, value: 'hydrated' });
  assert.deepEqual(retries, [1, 2]);
  assert.deepEqual(delays, [5, 15]);
});

test('does not retry a missing artifact', async () => {
  let calls = 0;
  await assert.rejects(
    retryArtifact(async () => {
      calls += 1;
      throw new Error('HTTP 404 while reading artifact metadata');
    }),
  );
  assert.equal(calls, 1);
});
