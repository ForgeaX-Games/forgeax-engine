import assert from 'node:assert/strict';
import test from 'node:test';

import { compareRequiredChecks } from '../audit-required-checks-ruleset.mjs';

test('required-check comparison is order-independent and reports both drift directions', () => {
  assert.deepEqual(
    compareRequiredChecks(['coverage-pnpm', 'primary-pnpm'], ['primary-pnpm', 'coverage-pnpm']),
    {
      ok: true,
      local: ['coverage-pnpm', 'primary-pnpm'],
      remote: ['coverage-pnpm', 'primary-pnpm'],
      missingRemotely: [],
      extraRemotely: [],
    },
  );
  assert.deepEqual(compareRequiredChecks(['coverage-pnpm'], ['primary-pnpm']), {
    ok: false,
    local: ['coverage-pnpm'],
    remote: ['primary-pnpm'],
    missingRemotely: ['coverage-pnpm'],
    extraRemotely: ['primary-pnpm'],
  });
});
