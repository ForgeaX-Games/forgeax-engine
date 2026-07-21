import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const uploadWithRetry = readFileSync(
  resolve('.github/actions/upload-artifact-with-retry/action.yml'),
  'utf8',
);
const uploadOptionalArtifact = readFileSync(
  resolve('.github/actions/upload-optional-artifact/action.yml'),
  'utf8',
);

test('primary coverage bounds Vitest workers on the shared self-hosted machine', () => {
  assert.match(workflow, /pnpm exec vitest run --maxWorkers=4 --typecheck --coverage/);
});

test('primary coverage uploads diagnostics only after a failed test run', () => {
  assert.match(
    workflow,
    /- name: Upload coverage diagnostics on failure[\s\S]*?if: failure\(\)[\s\S]*?uses: \.\/\.github\/actions\/upload-optional-artifact/,
  );
  assert.doesNotMatch(workflow, /^\s+continue-on-error: true$/m);
  assert.match(
    uploadOptionalArtifact,
    /continue-on-error: true[\s\S]*?uses: actions\/upload-artifact@v6/,
  );
  assert.match(
    uploadWithRetry,
    /id: upload[\s\S]*?continue-on-error: true[\s\S]*?if: steps\.upload\.outcome == 'failure'/,
  );
  assert.equal(uploadWithRetry.match(/continue-on-error: true/g)?.length, 2);
});
