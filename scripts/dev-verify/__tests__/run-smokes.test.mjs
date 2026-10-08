import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  parseObservedFrameReceipt,
  readRoster,
  resolveRunnableEntries,
} from '../../ci/run-dawn-smoke-roster.mjs';
import {
  classifyIndependentSmokeResult,
  summarizeSmokeCoverage,
} from '../wave1-rendering/run-smokes.mjs';

const root = resolve(import.meta.dirname, '../../..');

test('Wave1 plan retains every canonical owner including transmission assertions', () => {
  const output = mkdtempSync(join(tmpdir(), 'wave1-smoke-plan-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/dev-verify/wave1-rendering/run-smokes.mjs', '--plan', '--output-dir', output],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(readFileSync(join(output, 'plan.json'), 'utf8'));
    const canonical = resolveRunnableEntries({ roster: readRoster() });
    const shardedFrames = canonical.runnable.filter(
      (entry) => entry.oracle.kind === 'frameReceipt',
    );
    const independentFrames = canonical.independent.filter(
      (entry) => entry.oracle.kind === 'frameReceipt',
    );
    const independentNonFrames = canonical.independent.filter(
      (entry) => entry.oracle.kind !== 'frameReceipt',
    );
    const expectedFrameReceipts = shardedFrames.length + independentFrames.length;
    assert.deepEqual(
      plan.sharded.map((entry) => entry.gateId),
      canonical.runnable.map((entry) => entry.gateId),
    );
    assert.deepEqual(
      plan.independentFrameReceipt.map((entry) => entry.gateId),
      independentFrames.map((entry) => entry.gateId),
    );
    assert.deepEqual(
      plan.independentNonFrameReceipt.map((entry) => entry.gateId),
      independentNonFrames.map((entry) => entry.gateId),
    );
    assert.ok(
      plan.independentFrameReceipt.some(
        (entry) => entry.gateId === 'hello-material-projection/smoke',
      ),
    );
    const assertions = plan.sharded.filter((entry) => entry.oracle.kind === 'assertion');
    assert.deepEqual(
      assertions.map((entry) => entry.commandId),
      ['smoke:features-a', 'smoke:features-b'],
    );
    assert.equal(plan.counts.sharded, canonical.runnable.length);
    assert.equal(plan.counts.runnableFrameReceipt, expectedFrameReceipts);
    assert.equal(plan.counts.independentNonFrameReceipt, independentNonFrames.length);
    assert.equal(
      plan.independentFrameReceipt.filter((entry) => entry.classification === 'supplemental')
        .length,
      5,
    );

    const passed = (entry) => ({
      gateId: entry.gateId,
      status: 'pass',
      receipt:
        entry.oracle.kind === 'frameReceipt'
          ? parseObservedFrameReceipt('[smoke] frames observed=60\n[smoke] PASS', entry)
          : null,
    });
    const aggregate = { runnableResults: plan.sharded.map(passed) };
    const independent = plan.independentFrameReceipt.map(passed);
    const coverage = summarizeSmokeCoverage(plan, aggregate, independent);
    assert.equal(coverage.expectedFrameReceiptGates, expectedFrameReceipts);
    assert.equal(coverage.observedFrameReceiptGates, expectedFrameReceipts);
    assert.equal(coverage.shardedFrameReceiptGates, shardedFrames.length);
    assert.equal(coverage.independentFrameReceiptGates, independentFrames.length);
    assert.equal(coverage.independentNonFrameReceiptGates, independentNonFrames.length);

    const incomplete = structuredClone(aggregate);
    const frame = incomplete.runnableResults.find((entry) => entry.receipt !== null);
    frame.status = 'fail';
    assert.equal(
      summarizeSmokeCoverage(plan, incomplete, independent).observedFrameReceiptGates,
      expectedFrameReceipts - 1,
    );
    frame.status = 'pass';
    frame.receipt = null;
    assert.equal(
      summarizeSmokeCoverage(plan, incomplete, independent).observedFrameReceiptGates,
      expectedFrameReceipts - 1,
    );
    delete frame.receipt;
    assert.equal(
      summarizeSmokeCoverage(plan, incomplete, independent).observedFrameReceiptGates,
      expectedFrameReceipts - 1,
    );
    independent[0].status = 'fail';
    assert.equal(
      summarizeSmokeCoverage(plan, aggregate, independent).observedFrameReceiptGates,
      expectedFrameReceipts - 1,
    );
    assert.equal(summarizeSmokeCoverage(plan, null, []).observedFrameReceiptGates, 0);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

const receipt = { framesObserved: 60 };
const result = ({ output = '', exitCode = 0, signal = null, timedOut = false } = {}) => ({
  exitCode,
  signal,
  timedOut,
  output,
});

test('Wave1 independent smoke classification keeps optional unavailable diagnostics out of a receipt-backed gate', () => {
  assert.deepEqual(
    classifyIndependentSmokeResult(
      result({
        output: '[forgeax-smoke-receipt] frames=60\nfeature timing unavailable',
      }),
      receipt,
    ),
    {
      unavailable: true,
      skipped: false,
      unavailableOrSkipped: false,
      status: 'pass',
    },
  );
});

test('Wave1 independent smoke classification fails closed without a canonical receipt', () => {
  assert.deepEqual(
    classifyIndependentSmokeResult(result({ output: 'optional capability unavailable' }), null),
    {
      unavailable: true,
      skipped: false,
      unavailableOrSkipped: true,
      status: 'fail',
    },
  );
});

test('Wave1 independent smoke classification fails closed for nonzero, signal, timeout, and short frames', () => {
  for (const [label, actual] of [
    ['nonzero exit', result({ exitCode: 7 })],
    ['signal', result({ signal: 'SIGTERM' })],
    ['timeout', result({ timedOut: true })],
    ['short frame receipt', result({ output: '[forgeax-smoke-receipt] frames=59' })],
  ]) {
    assert.equal(
      classifyIndependentSmokeResult(actual, actual.output ? { framesObserved: 59 } : receipt)
        .status,
      'fail',
      label,
    );
  }
});
