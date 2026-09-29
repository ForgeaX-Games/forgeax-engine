import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIndependentSmokeResult } from '../wave1-rendering/run-smokes.mjs';

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
