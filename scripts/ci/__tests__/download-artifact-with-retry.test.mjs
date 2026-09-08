import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_IDLE_TIMEOUT_MS,
  ARTIFACT_REQUEST_TIMEOUT_MS,
  artifactNamePattern,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  discoverRunArtifacts,
  downloadArtifact,
  ensureArtifactDestination,
  isRetryableTransportError,
  observeArtifactDownload,
  parseArtifactIds,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_SECONDS,
  readResponseBody,
  retryArtifact,
  selectRunArtifacts,
} from '../download-artifact-with-retry.mjs';

test('records download timing around the physical transport owner exactly once', async () => {
  const timestamps = [1000, 3250];
  let calls = 0;
  const observation = await observeArtifactDownload(
    async () => {
      calls += 1;
      return 4096;
    },
    { nowFn: () => timestamps.shift(), transferAttempt: 1 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(observation, {
    compressedArchiveBytes: 4096,
    download: {
      startedAt: '1970-01-01T00:00:01.000Z',
      completedAt: '1970-01-01T00:00:03.250Z',
      elapsedSeconds: 2.25,
      transferAttempt: 1,
    },
  });
});

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

test('streams an artifact response to disk while preserving its digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-artifact-stream-'));
  const destination = join(root, 'archive.zip');
  const archive = Buffer.from('streamed artifact payload');
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/actions/artifacts/42'))
        return new Response(JSON.stringify({ expired: false, digest }), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response(archive);
    };
    assert.equal(await downloadArtifact('owner/repo', '42', destination), archive.byteLength);
    assert.deepEqual(await readFile(destination), archive);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('retries only bounded artifact transport failures', () => {
  assert.deepEqual(RETRY_DELAYS_SECONDS, [0, 5, 15]);
  assert.equal(ARTIFACT_IDLE_TIMEOUT_MS, 120_000);
  assert.equal(ARTIFACT_REQUEST_TIMEOUT_MS, 180_000);
  assert.equal(REQUEST_TIMEOUT_MS, 180_000);
  assert.ok(
    ARTIFACT_REQUEST_TIMEOUT_MS * RETRY_DELAYS_SECONDS.length +
      RETRY_DELAYS_SECONDS.reduce((total, delay) => total + delay * 1000, 0) <
      15 * 60 * 1000,
    'all retries must fit inside the shortest artifact consumer job budget',
  );
  assert.equal(DOWNLOAD_IDLE_TIMEOUT_MS, 120_000);
  for (const message of [
    'read ECONNRESET',
    'terminated other side closed UND_ERR_SOCKET',
    'Failed to GetSignedArtifactURL: request failed',
    'fetch failed: socket hang up',
    'HTTP 408 while reading artifact service',
    'HTTP 429 while reading artifact service',
    'HTTP 502 while reading artifact service',
    'HTTP 503 while reading artifact service',
    'artifact transfer idle timeout after 120000ms',
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

test('aborts a stalled artifact endpoint so transport retry can recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-artifact-timeout-'));
  const destination = join(root, 'archive.zip');
  const archive = Buffer.from('metadata only');
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).endsWith('/actions/artifacts/42'))
        return new Response(JSON.stringify({ expired: false, digest }), {
          headers: { 'content-type': 'application/json' },
        });
      return await new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    };
    await assert.rejects(
      downloadArtifact('owner/repo', '42', destination, {
        idleTimeoutMs: 10,
        requestTimeoutMs: 10,
      }),
      /artifact request timeout after 10ms/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('aborts and classifies an idle response body instead of hanging forever', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  await assert.rejects(
    readResponseBody(new Response(body), { controller, idleTimeoutMs: 20 }),
    /artifact download idle timeout after 20ms/,
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, true);
});

test('requires non-empty numeric exact artifact IDs', () => {
  assert.deepEqual(parseArtifactIds('12, 34'), ['12', '34']);
  for (const value of ['', '12,,34', 'a12', '0', '-3']) {
    assert.throws(() => parseArtifactIds(value), /artifact IDs/);
  }
});

test('discovers one immutable artifact ID per matrix producer and preserves artifact directories', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          total_count: 5,
          artifacts: [
            { id: 14, name: 'unrelated', expired: false },
            { id: 13, name: 'deferred-membership-real-corpus-shard-3-a1', expired: false },
            {
              id: 10,
              name: 'deferred-membership-real-corpus-shard-0-a1-retry-2-a1',
              expired: false,
            },
            { id: 12, name: 'deferred-membership-real-corpus-shard-2-a1', expired: false },
            { id: 11, name: 'deferred-membership-real-corpus-shard-1-a1', expired: false },
          ],
        }),
      );
    const artifacts = await discoverRunArtifacts(
      'owner/repo',
      99,
      'deferred-membership-real-corpus-shard-*-a1*',
      4,
    );
    assert.deepEqual(
      artifacts.map(({ id, name }) => ({ id, name })),
      [
        { id: 10, name: 'deferred-membership-real-corpus-shard-0-a1-retry-2-a1' },
        { id: 11, name: 'deferred-membership-real-corpus-shard-1-a1' },
        { id: 12, name: 'deferred-membership-real-corpus-shard-2-a1' },
        { id: 13, name: 'deferred-membership-real-corpus-shard-3-a1' },
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test('fails closed when matrix artifact discovery is partial, duplicated, or unsafe', () => {
  assert.equal(artifactNamePattern('shard-*-a1*').test('shard-0-a1-retry-2-a1'), true);
  assert.throws(
    () => selectRunArtifacts([{ id: 1, name: 'shard-0-a1', expired: false }], 'shard-*-a1*', 4),
    /matched 1; expected exactly 4/,
  );
  assert.throws(
    () =>
      selectRunArtifacts(
        [
          { id: 1, name: 'shard-0-a1', expired: false },
          { id: 1, name: 'shard-1-a1', expired: false },
        ],
        'shard-*-a1*',
        2,
      ),
    /duplicate IDs/,
  );
  assert.throws(
    () => selectRunArtifacts([{ id: 1, name: 'shard-../a1', expired: false }], 'shard-*', 1),
    /unsafe artifact name/,
  );
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

test('passes the one-based retry attempt into the download observation', async () => {
  const attempts = [];
  const result = await retryArtifact(
    (attempt) => {
      attempts.push(attempt);
      return observeArtifactDownload(async () => 12, {
        nowFn: () => 1000,
        transferAttempt: attempt,
      });
    },
    { sleepFn: async () => {} },
  );
  assert.deepEqual(attempts, [1]);
  assert.equal(result.value.download.transferAttempt, 1);
});

test('rejects missing or invalid transfer-attempt observations', async () => {
  for (const transferAttempt of [null, 0, -1, 1.5, 4, '1']) {
    await assert.rejects(
      observeArtifactDownload(async () => 12, { nowFn: () => 1000, transferAttempt }),
      /observation is invalid/,
    );
  }
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
