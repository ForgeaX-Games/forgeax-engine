import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as smoke from '../run-dawn-smoke-roster.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const identity = { gateId: 'budget/smoke', commandId: 'smoke' };
const line = (framesObserved, overrides = {}) =>
  `${smoke.RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    ...identity,
    framesObserved,
    completed: true,
    ...overrides,
  })}`;

test('budget is default 60 or a strict safe integer at least 60', () => {
  assert.equal(smoke.parseSmokeFrameBudget(), 60);
  for (const value of [60, 300, '60', '300'])
    assert.equal(smoke.parseSmokeFrameBudget(value), Number(value));
  for (const value of [
    null,
    '',
    ' ',
    0,
    59,
    299.5,
    '300frames',
    '3e2',
    Infinity,
    NaN,
    true,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => smoke.parseSmokeFrameBudget(value), /frame|budget|integer/i);
});

test('CLI accepts an explicit external budget and rejects invalid requests', () => {
  assert.equal(smoke.parseCli(['--frames', '300']).frames, 300);
  for (const value of ['59', '300x', '1.5', ''])
    assert.throws(() => smoke.parseCli(['--frames', value]), /frame|budget|integer/i);
  assert.throws(() => smoke.parseCli(['--frames']), /frame|budget|integer/i);
});

test('external 300 rejects short, incomplete, duplicated and self-downgraded receipts', () => {
  const request = { ...identity, frames: 300 };
  assert.equal(smoke.parseObservedFrameReceipt(line(300), request).framesObserved, 300);
  for (const output of [
    line(60),
    line(299),
    line(300, { completed: false }),
    line(300, { framesExpected: 60 }),
    `${line(300)}\n${line(300)}`,
    'SMOKE_MIN_FRAMES=300',
  ])
    assert.throws(() => smoke.parseObservedFrameReceipt(output, request), /receipt|frame|minimum/i);
  assert.throws(
    () => smoke.parseObservedFrameReceipt('[smoke] frames observed=299\n[smoke] PASS', request),
    /frame|receipt/i,
  );
});

const entry = {
  package: '@forgeax/budget',
  path: 'apps/hello/budget/package.json',
  ...identity,
  oracle: { kind: 'frameReceipt', parserId: smoke.RECEIPT_PARSER_ID },
  command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(smoke.RECEIPT_PREFIX)}+JSON.stringify({schemaVersion:1,gateId:"${identity.gateId}",commandId:"smoke",framesObserved:Number(process.env.SMOKE_MIN_FRAMES),completed:true}))`}'`,
};

for (const frames of [undefined, 300]) {
  test(`real child command receives ${frames ?? 'default 60'} without a graphics backend`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-budget-'));
    try {
      const result = await smoke.runEntry({
        entry,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
        frames,
      });
      assert.equal(result.status, 'pass');
      assert.equal(result.framesExpected, frames ?? 60);
      assert.equal(result.framesObserved, frames ?? 60);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function evidence(frames = 300) {
  const resolved = {
    declared: [],
    runnable: [entry],
    independent: [],
    exclusions: [],
    declaredGateIds: [entry.gateId],
    runnableGateIds: [entry.gateId],
    independentGateIds: [],
    excludedGateIds: [],
  };
  const receipt = smoke.parseObservedFrameReceipt(line(frames), identity);
  const result = {
    ...entry,
    shardIndex: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    unavailable: false,
    skipped: false,
    unavailableOrSkipped: false,
    framesObserved: frames,
    framesExpected: frames,
    status: 'pass',
    result: 'pass',
    failureReason: null,
    logPath: 'logs/budget.log',
    logSha256: digest,
    logBytes: 1,
    receipt,
    commandResults: [{ commandId: 'smoke', command: entry.command, exitCode: 0, status: 'pass' }],
  };
  const reports = [0, 1].map((shardIndex) =>
    smoke.buildShardReport({
      resolved,
      assigned: shardIndex === 0 ? [entry] : [],
      results: shardIndex === 0 ? [result] : [],
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardIndex,
      shardCount: 2,
      frames,
    }),
  );
  return {
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    shardCount: 2,
    frames: 300,
  };
}

test('aggregate admits only the external budget with complete exact-HEAD owner closure', () => {
  assert.equal(smoke.aggregateReports(evidence()).framesExpected, 300);
  assert.throws(() => smoke.aggregateReports(evidence(60)), /frame|budget/i);
  for (const [name, mutate] of [
    [
      'mixed budget',
      (e) => {
        e.reports[1].framesExpected = 60;
      },
    ],
    [
      'short receipt',
      (e) => {
        e.reports[0].runnableEntries[0].receipt = smoke.parseObservedFrameReceipt(
          line(299),
          identity,
        );
        e.reports[0].runnableEntries[0].framesObserved = 299;
      },
    ],
    [
      'missing receipt',
      (e) => {
        e.reports[0].runnableEntries[0].receipt = null;
      },
    ],
    [
      'incomplete',
      (e) => {
        e.reports[0].runnableEntries[0].receipt.completed = false;
      },
    ],
    [
      'missing owner',
      (e) => {
        e.reports[0].runnableEntries = [];
      },
    ],
    [
      'duplicate owner',
      (e) => {
        e.reports[0].runnableEntries.push(e.reports[0].runnableEntries[0]);
      },
    ],
    [
      'wrong HEAD',
      (e) => {
        e.reports[0].head = 'b'.repeat(40);
      },
    ],
    [
      'wrong expected HEAD',
      (e) => {
        e.reports[0].expectedProductSha = 'b'.repeat(40);
      },
    ],
  ]) {
    const e = evidence();
    mutate(e);
    assert.throws(() => smoke.aggregateReports(e), undefined, name);
  }
});

test('full fleet conserves 92 gates: 88 frame owners and 4 semantic owners', () => {
  const resolved = smoke.resolveRunnableEntries({ roster: smoke.readRoster() });
  const entries = smoke.selectSmokeEntries(resolved, 'full');
  assert.equal(smoke.selectSmokeEntries(resolved).length, 30);
  assert.equal(entries.length, 92);
  assert.equal(entries.filter((e) => e.oracle.kind === 'frameReceipt').length, 88);
  const reports = [0, 1, 2, 3].map((shardIndex) => {
    const assigned = smoke.partitionRunnableEntries(entries, { shardIndex });
    const results = assigned.map((e) => ({
      ...evidence().reports[0].runnableEntries[0],
      ...e,
      shardIndex,
      framesObserved: e.oracle.kind === 'frameReceipt' ? 300 : null,
      receipt:
        e.oracle.kind === 'frameReceipt'
          ? smoke.parseObservedFrameReceipt(
              line(300, { gateId: e.gateId, commandId: e.commandId }),
              { ...e, frames: 300 },
            )
          : null,
      commandResults: [{ commandId: e.commandId, command: e.command, exitCode: 0, status: 'pass' }],
    }));
    return smoke.buildShardReport({
      resolved,
      assigned,
      results,
      head,
      expectedProductSha: head,
      rosterDigest: digest,
      shardIndex,
      frames: 300,
      scope: 'full',
    });
  });
  const request = {
    reports,
    resolved,
    head,
    expectedProductSha: head,
    rosterDigest: digest,
    frames: 300,
    scope: 'full',
  };
  assert.equal(smoke.aggregateReports(request).runnableResults.length, 92);
  assert.equal(
    reports.flatMap((r) => r.runnableEntries).filter((e) => e.receipt === null).length,
    4,
  );
  assert.throws(() => smoke.aggregateReports({ ...request, scope: 'sharded' }), /scope/);
  assert.throws(() => smoke.aggregateReports({ ...request, allowBlocked: true }), /blocked/);
  for (const mutate of [
    (r) => {
      r[0].runnableEntries.pop();
    },
    (r) => {
      r[0].runnableEntries.push(r[0].runnableEntries[0]);
    },
    (r) => {
      r[0].rosterDigest = 'b'.repeat(64);
    },
    (r) => {
      r[0].framesExpected = 60;
    },
    (r) => {
      r.flatMap((s) => s.runnableEntries).find((e) => e.receipt === null).framesObserved = 300;
    },
    (r) => {
      r.flatMap((s) => s.runnableEntries).find((e) => e.receipt === null).skipped = true;
    },
    (r) => {
      r[0].runnableEntries[0].commandResults[0].exitCode = 1;
    },
    (r) => {
      r[0].runnableEntries[0].timedOut = true;
    },
  ]) {
    const changed = structuredClone(reports);
    mutate(changed);
    assert.throws(() => smoke.aggregateReports({ ...request, reports: changed }));
  }
});

test('semantic owners retain assertions without fabricated frames or optional-provenance failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-semantic-'));
  try {
    const makeEntry = (output, gateId) => ({
      ...entry,
      gateId,
      oracle: { kind: 'composite' },
      command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(output)})`}'`,
    });
    const run = (e) =>
      smoke.runEntry({
        entry: e,
        frames: 300,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
      });
    const good = await run(
      makeEntry(`${line(300)}\n{"wasmBindgen":"unavailable"}\n[smoke] PASS`, 'semantic/all'),
    );
    assert.equal(good.status, 'pass');
    assert.equal(good.receipt, null);
    assert.equal(good.framesObserved, null);
    const bad = await run(makeEntry('[smoke] SKIPPED', 'semantic/skip'));
    assert.equal(bad.status, 'fail');
    assert.notEqual(good.logPath, bad.logPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repaired owners derive their loop budgets and preserve independent sampling windows', () => {
  const source = (path) =>
    readFileSync(new URL(`../../../apps/${path}/scripts/smoke-dawn.mjs`, import.meta.url), 'utf8');
  for (const [path, variable] of [
    ['hello/cinder-fall', 'FRAMES'],
    ['hello/custom-shader', 'FRAME_COUNT'],
    ['hello/fbx-cube', 'SMOKE_MIN_FRAMES'],
    ['hello/boss-lightning', 'TARGET_FRAMES'],
    ['hello/fxaa', 'VALIDATION_FRAME_COUNT'],
    ['hello/transform-hierarchy', 'FLEET_FRAME_COUNT'],
    ['learn-render/5.advanced-lighting/7.bloom', 'SMOKE_MIN_FRAMES'],
    ['learn-render/6.pbr/4.render-target-reflection', 'MIN_FRAMES'],
    ['hello/bloom', 'REQUESTED_FRAMES'],
    ['hello/lod-occlusion', 'frames'],
  ]) {
    const text = source(path);
    const expression = text.match(new RegExp(`const ${variable} = ([^;]+);`))?.[1];
    assert.ok(expression, path);
    for (const frames of [60, 300])
      assert.equal(
        runInNewContext(expression, {
          smokeFrameBudget: (value = frames) => smoke.parseSmokeFrameBudget(value),
          process: { env: { SMOKE_MIN_FRAMES: String(frames) } },
        }),
        frames,
        path,
      );
  }
  assert.match(
    source('hello/entity-visibility'),
    /runVisibilityDawnSmoke\(\{ frames: Math\.max\(60, Number\.parseInt\(process\.env\.SMOKE_MIN_FRAMES/,
  );
  assert.match(source('hello/boss-lightning'), /frameLimit = benchmarkMode \? 90 : TARGET_FRAMES/);
  assert.match(source('hello/bloom'), /const SMOKE_MIN_FRAMES = 60;/);
  assert.match(source('hello/bloom'), /if \(!CAPTURE_GPU_TIMINGS && !FALSIFY_BLOOM\)/);
  assert.match(source('hello/fxaa'), /Math\.min\(framesNone, framesFxaa\)/);
});

test('aggregate re-parses the actual child log and rejects report-only completion claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-log-proof-'));
  try {
    const result = await smoke.runEntry({
      entry,
      shardIndex: 0,
      frames: 300,
      reportPath: join(directory, 'shard.json'),
      timeoutMs: 10_000,
    });
    const request = evidence();
    request.reports[0].runnableEntries = [result];
    request.reportDirectory = directory;
    assert.equal(smoke.aggregateReports(request).status, 'pass');
    const tampered = structuredClone(request);
    tampered.reports[0].runnableEntries[0].receipt.rawLineSha256 = 'f'.repeat(64);
    assert.throws(() => smoke.aggregateReports(tampered), /projection|digest/);
    writeFileSync(join(directory, result.logPath), line(60));
    assert.throws(() => smoke.aggregateReports(request), /log byte|log digest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('optional setup prose cannot override complete frame or semantic evidence', async () => {
  const optional = '[postinstall] skipping optional fetch';
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n${optional}`, { hasReceipt: true }),
    false,
  );
  // Exact terminal formats from asi-world/tilemap and the transmission browser
  // owner. Owner tags remain open; setup prose is not a terminal status token.
  for (const verdict of [
    '[hello-tilemap smoke] env-deferred=no-adapter',
    '[learn-render 6.4 transmission-refraction] NOT-RUN: display unavailable',
    '[another-owner] SKIP: missing prerequisite',
    '[another-owner] SKIPPED',
  ])
    assert.equal(
      smoke.hasUnavailableOrSkipped(`${line(300)}\n${verdict}`, { hasReceipt: true }),
      true,
    );
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-optional-setup-'));
  try {
    const run = (kind, output) =>
      smoke.runEntry({
        entry: {
          ...entry,
          oracle: { kind },
          command: `${JSON.stringify(process.execPath)} -e '${`console.log(${JSON.stringify(output)})`}'`,
        },
        frames: 300,
        shardIndex: 0,
        reportPath: join(directory, 'shard.json'),
        timeoutMs: 10_000,
      });
    for (const kind of ['assertion', 'composite']) {
      assert.equal((await run(kind, `${optional}\n[owner] PASS`)).status, 'pass');
      assert.equal((await run(kind, '[owner] SKIP: unavailable gate')).status, 'fail');
    }
    assert.notEqual((await run('frameReceipt', optional)).status, 'pass');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a receipt cannot mask an explicit skipped gate', () => {
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n[smoke] SKIPPED`, { hasReceipt: true }),
    true,
  );
  assert.equal(smoke.hasUnavailableOrSkipped('SKIP missing gate', { hasReceipt: true }), true);
  // Falsifier failures are interpreted by their complete command, not word scanning.
  assert.equal(
    smoke.hasUnavailableOrSkipped(`${line(300)}\n[smoke] FAIL - expected falsifier`, {
      hasReceipt: true,
    }),
    false,
  );
});
