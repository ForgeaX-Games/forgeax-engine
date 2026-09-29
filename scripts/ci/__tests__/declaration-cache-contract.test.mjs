import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

test('declaration cache restores only an exact source key', () => {
  const restore = workflow.indexOf('name: Restore .tsbuildinfo + .d.ts');
  const invalidate = workflow.indexOf('name: Invalidate stale buildinfo');
  const engineFacades = workflow.indexOf(
    'name: Materialize generated Engine facade declarations before app typecheck',
  );
  const typecheck = workflow.indexOf('name: Vitest typecheck');

  assert.ok(
    restore >= 0 && invalidate > restore && engineFacades > invalidate && typecheck > engineFacades,
  );
  const step = workflow.slice(invalidate, typecheck);
  assert.match(step, /cache-tsbuildinfo\.outputs\.cache-hit != 'true'/);
  assert.match(step, /find packages apps -path '\*\/dist\/\.tsbuildinfo' -delete/);
  assert.match(step, /pnpm --filter @forgeax\/engine build/);
  assert.match(step, /test -s packages\/engine\/dist\/facades\/pack\/guid\.d\.ts/);
  assert.doesNotMatch(workflow.slice(restore, invalidate), /restore-keys:/);
  const engineStep = workflow.slice(engineFacades, typecheck);
  assert.match(engineStep, /if: steps\.cache-tsbuildinfo\.outputs\.cache-hit != 'true'/);
});
