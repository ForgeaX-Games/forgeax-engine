import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  materializeHarnessDocs,
  missingHarnessDocs,
  REQUIRED_HARNESS_DOCS,
} from '../materialize-harness-docs.mjs';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'materialize-harness-docs-'));
}

function writeRequiredDocs(rootDir) {
  for (const document of REQUIRED_HARNESS_DOCS) {
    const path = join(rootDir, '.forgeax-harness', document);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'fixture\n');
  }
}

test('retries a successful sync when the floating tree is temporarily incomplete', async () => {
  const rootDir = makeRoot();
  try {
    let syncCalls = 0;
    const delays = [];
    const result = await materializeHarnessDocs({
      rootDir,
      retryDelaysMs: [0, 10, 20],
      sync: () => {
        syncCalls += 1;
        if (syncCalls === 2) writeRequiredDocs(rootDir);
        return { status: 0 };
      },
      sleepFn: async (delay) => delays.push(delay),
      log: () => {},
    });

    assert.deepEqual(result, { ok: true, attempts: 2, missing: [], syncStatus: 0 });
    assert.equal(syncCalls, 2);
    assert.deepEqual(delays, [10]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('keeps the missing-document failure bounded', async () => {
  const rootDir = makeRoot();
  try {
    let syncCalls = 0;
    const delays = [];
    const result = await materializeHarnessDocs({
      rootDir,
      retryDelaysMs: [0, 10, 20],
      sync: () => {
        syncCalls += 1;
        return { status: 0 };
      },
      sleepFn: async (delay) => delays.push(delay),
      log: () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
    assert.equal(syncCalls, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.deepEqual(result.missing, REQUIRED_HARNESS_DOCS);
    assert.deepEqual(missingHarnessDocs(rootDir), REQUIRED_HARNESS_DOCS);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not retry an explicit sync failure', async () => {
  const rootDir = makeRoot();
  try {
    let syncCalls = 0;
    const result = await materializeHarnessDocs({
      rootDir,
      retryDelaysMs: [0, 10, 20],
      sync: () => {
        syncCalls += 1;
        return { status: 1 };
      },
      sleepFn: async () => {
        throw new Error('sleep should not be called');
      },
      log: () => {},
    });

    assert.deepEqual(result, {
      ok: false,
      attempts: 1,
      missing: REQUIRED_HARNESS_DOCS,
      syncStatus: 1,
    });
    assert.equal(syncCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
