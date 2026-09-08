import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

test('prefix-restored declarations discard buildinfo before rebuilding', () => {
  const restore = workflow.indexOf('name: Restore .tsbuildinfo + .d.ts');
  const invalidate = workflow.indexOf('name: Invalidate prefix-restored buildinfo');
  const typecheck = workflow.indexOf('name: Vitest typecheck');

  assert.ok(restore >= 0 && invalidate > restore && typecheck > invalidate);
  const step = workflow.slice(invalidate, typecheck);
  assert.match(step, /cache-tsbuildinfo\.outputs\.cache-hit != 'true'/);
  assert.match(step, /find packages apps -path '\*\/dist\/\.tsbuildinfo' -delete/);
});
