import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  aggregateReports,
  discoverCandidates,
  hasUnavailableOrSkipped,
  partitionRunnableEntries,
  readRoster,
  resolveRunnableEntries,
  resultStatus,
  validateShardReport,
} from '../run-dawn-smoke-roster.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';
const digest = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const directGate = {
  gateId: 'direct/smoke',
  commandId: 'smoke',
  executionClass: 'sharded',
  commandSource: 'manifest-smokeInvocation',
  commands: [{ commandId: 'smoke', source: 'manifest-smokeInvocation' }],
  oracle: { kind: 'frameReceipt', parserId: 'forgeax-smoke-receipt-v1' },
};
const excludedGate = {
  gateId: 'browser/smoke',
  commandId: 'smoke',
  executionClass: 'excluded',
  commandSource: 'manifest-smokeInvocation',
  commands: [{ commandId: 'smoke', source: 'manifest-smokeInvocation' }],
  oracle: { kind: 'assertion' },
};

function fixtureRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forgeax-dawn-roster-'));
  for (const [directory, name, invocation] of [
    ['apps/hello/direct', '@forgeax/direct', 'pnpm --filter @forgeax/direct smoke'],
    ['apps/hello/browser', '@forgeax/browser', 'pnpm --filter @forgeax/browser smoke:all'],
  ]) {
    const packageDirectory = join(repoRoot, directory);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name, forgeax: { smokeInvocation: invocation } })}\n`,
    );
  }
  return repoRoot;
}

function rosterEntries() {
  return [
    {
      package: '@forgeax/direct',
      path: 'apps/hello/direct/package.json',
      classification: 'run',
      gates: [directGate],
    },
    {
      package: '@forgeax/browser',
      path: 'apps/hello/browser/package.json',
      classification: 'excluded',
      reason: 'browser smoke is not a direct Dawn smoke',
      gates: [excludedGate],
    },
  ];
}

function resolvedRoster() {
  const entries = rosterEntries();
  return {
    declared: entries,
    runnable: [{ ...entries[0], command: 'pnpm --filter @forgeax/direct smoke', ...directGate }],
    independent: [],
    exclusions: [entries[1]],
    declaredGateIds: ['direct/smoke', 'browser/smoke'],
    runnableGateIds: ['direct/smoke'],
    independentGateIds: [],
    excludedGateIds: ['browser/smoke'],
  };
}

function passResult(entry, shardIndex) {
  const rawLine =
    '[forgeax-smoke-receipt] {"schemaVersion":1,"gateId":"direct/smoke","commandId":"smoke","framesObserved":60,"completed":true}';
  return {
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId,
    commandId: entry.commandId,
    shardIndex,
    command: entry.command,
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: false,
    skipped: false,
    unavailableOrSkipped: false,
    framesObserved: 60,
    framesExpected: 60,
    status: 'pass',
    result: 'pass',
    failureReason: null,
    logPath: 'logs/direct.log',
    logSha256: '0'.repeat(64),
    logBytes: 1,
    receipt: {
      schemaVersion: 1,
      gateId: 'direct/smoke',
      commandId: 'smoke',
      framesObserved: 60,
      completed: true,
      rawLine,
      rawLineSha256: '1'.repeat(64),
      parserId: 'forgeax-smoke-receipt-v1',
    },
    commandResults: [{ commandId: 'smoke', command: entry.command, exitCode: 0, status: 'pass' }],
  };
}

function blockedResult(entry, shardIndex) {
  return {
    ...passResult(entry, shardIndex),
    framesObserved: null,
    status: 'blocked',
    result: 'blocked',
    failureReason: 'missing-frame-evidence',
    receipt: null,
    commandResults: [
      { commandId: 'smoke', command: entry.command, exitCode: 0, status: 'blocked' },
    ],
  };
}

function shard(index, results) {
  const resolved = resolvedRoster();
  return {
    schemaVersion: 2,
    kind: 'dawn-smoke-shard',
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardIndex: index,
    shardCount: 3,
    framesExpected: 60,
    declaredGateIds: resolved.declaredGateIds,
    runnableGateIds: resolved.runnableGateIds,
    independentGateIds: resolved.independentGateIds,
    excludedGateIds: resolved.excludedGateIds,
    declaredEntries: resolved.declared,
    runnableEntries: results,
    exclusions: resolved.exclusions,
    assignedGateIds: results.map((result) => result.gateId),
    assignedEntries: results.map(({ gateId, commandId }) => ({ gateId, commandId })),
  };
}

test('roster is the explicit gate membership authority and keeps command ownership in manifests', () => {
  const roster = readRoster();
  assert.equal(roster.schemaVersion, 2);
  assert.deepEqual(roster.roots, ['apps/hello', 'apps/learn-render']);
  assert.ok(roster.entries.length > 0);
  assert.ok(roster.entries.every((entry) => Array.isArray(entry.gates)));
});

test('manifest discovery only reports candidates and resolves gate commands', () => {
  const repoRoot = fixtureRepo();
  const candidates = discoverCandidates({ repoRoot, roots: ['apps/hello'] });
  assert.deepEqual(
    candidates.map(({ package: packageName, path }) => ({ package: packageName, path })),
    [
      { package: '@forgeax/browser', path: 'apps/hello/browser/package.json' },
      { package: '@forgeax/direct', path: 'apps/hello/direct/package.json' },
    ],
  );
  const roster = {
    schemaVersion: 2,
    roots: ['apps/hello'],
    entries: rosterEntries(),
  };
  const resolved = resolveRunnableEntries({ repoRoot, roster, roots: ['apps/hello'] });
  assert.deepEqual(resolved.runnable, [
    {
      package: '@forgeax/direct',
      path: 'apps/hello/direct/package.json',
      classification: 'run',
      gateId: 'direct/smoke',
      commandId: 'smoke',
      executionClass: 'sharded',
      oracle: directGate.oracle,
      command: 'pnpm --filter @forgeax/direct smoke',
    },
  ]);
  assert.deepEqual(resolved.exclusions, [rosterEntries()[1]]);
});

test('stable three-way partition covers runnable gates exactly once, including empty shards', () => {
  const entries = [
    { ...directGate, package: '@forgeax/z', path: 'apps/hello/z/package.json' },
    { ...directGate, package: '@forgeax/a', path: 'apps/hello/a/package.json' },
  ];
  const shards = [0, 1, 2].map((shardIndex) =>
    partitionRunnableEntries(entries, { shardIndex, shardCount: 3 }),
  );
  assert.deepEqual(
    shards[0].map((entry) => entry.package),
    ['@forgeax/a'],
  );
  assert.deepEqual(
    shards[1].map((entry) => entry.package),
    ['@forgeax/z'],
  );
  assert.deepEqual(shards[2], []);
  assert.deepEqual(
    shards
      .flat()
      .map((entry) => entry.path)
      .sort(),
    entries.map((entry) => entry.path).sort(),
  );
});

test('receipt-backed smoke keeps optional unavailable capability text out of the gate verdict', () => {
  const output = '[smoke] PASS - frames=60\\n{"performanceAdmission":{"status":"unavailable"}}';
  assert.equal(hasUnavailableOrSkipped(output), true);
  assert.equal(hasUnavailableOrSkipped(output, { hasReceipt: true }), false);
});

test('exit-zero smoke without a canonical receipt is blocked even when its log mentions skipping', () => {
  const result = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: '[postinstall] skipping optional fetch',
  };
  assert.equal(resultStatus(result, null, true), 'blocked');
});

test('aggregate accepts complete evidence and keeps exclusions out of execution results', () => {
  const resolved = resolvedRoster();
  const reports = [shard(0, [passResult(resolved.runnable[0], 0)]), shard(1, []), shard(2, [])];
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
  });
  assert.equal(aggregate.status, 'pass');
  assert.deepEqual(
    aggregate.runnableResults.map((entry) => entry.package),
    ['@forgeax/direct'],
  );
  assert.deepEqual(aggregate.exclusions, resolved.exclusions);
});

test('aggregate carries explicitly allowed missing receipts as blocked, never as pass', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const reports = [shard(0, [blockedResult(entry, 0)]), shard(1, []), shard(2, [])];
  assert.throws(
    () =>
      aggregateReports({
        reports,
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /blocked/i,
  );
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
    allowBlocked: true,
  });
  assert.equal(aggregate.status, 'blocked');
  assert.equal(aggregate.runnableResults[0].status, 'blocked');
  assert.equal(aggregate.runnableResults[0].receipt, null);
});

test('aggregate keeps receipt-less skip text blocked when the defer path is explicitly allowed', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const reports = [shard(0, [blockedResult(entry, 0)]), shard(1, []), shard(2, [])];
  reports[0].runnableEntries[0].unavailableOrSkipped = true;
  const aggregate = aggregateReports({
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 3,
    allowBlocked: true,
  });
  assert.equal(aggregate.status, 'blocked');
  assert.equal(aggregate.runnableResults[0].status, 'blocked');
});

test('aggregate fails closed for missing, duplicate, stale, skipped, and short-frame evidence', () => {
  const resolved = resolvedRoster();
  const entry = resolved.runnable[0];
  const complete = [shard(0, [passResult(entry, 0)]), shard(1, []), shard(2, [])];
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.slice(0, 2),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /missing shard/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: [shard(0, [passResult(entry, 0)]), shard(1, [passResult(entry, 1)]), shard(2, [])],
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /duplicate|extra|complete/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({ ...report, head: '0'.repeat(40) })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /head/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({
          ...report,
          runnableEntries: report.runnableEntries.map((result) => ({
            ...result,
            framesObserved: 59,
            receipt: { ...result.receipt, framesObserved: 59 },
          })),
        })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /frame/i,
  );
  assert.throws(
    () =>
      aggregateReports({
        reports: complete.map((report) => ({
          ...report,
          runnableEntries: report.runnableEntries.map((result) => ({
            ...result,
            status: 'fail',
            result: 'fail',
            unavailableOrSkipped: true,
            commandResults: result.commandResults.map((command) => ({
              ...command,
              status: 'fail',
            })),
          })),
        })),
        resolved,
        head,
        expectedProductSha: head,
        rosterDigest: digest,
        shardCount: 3,
      }),
    /pass|unavailable|skipped/i,
  );
  assert.throws(
    () =>
      validateShardReport({
        ...complete[0],
        runnableEntries: [passResult(entry, 0), passResult(entry, 0)],
      }),
    /duplicate/i,
  );
});
