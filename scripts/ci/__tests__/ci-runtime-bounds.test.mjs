import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const vitestConfig = readFileSync(resolve('vitest.config.ts'), 'utf8');
const uploadWithRetry = readFileSync(
  resolve('.github/actions/upload-artifact-with-retry/action.yml'),
  'utf8',
);
const uploadOptionalArtifact = readFileSync(
  resolve('.github/actions/upload-optional-artifact/action.yml'),
  'utf8',
);

test('coverage-pnpm bounds Vitest workers on the shared self-hosted machine', () => {
  assert.match(workflow, /pnpm exec vitest run --maxWorkers=4 --typecheck --coverage/);
});

test('CI harness materialization uses a blob-filtered docs-only clone', () => {
  const materializeSteps = workflow.match(
    /- name: Materialize harness documentation[\s\S]*?FORGEAX_HARNESS_SPARSE_DOCS: '1'/g,
  );
  assert.equal(materializeSteps?.length, 2);
  assert.match(
    readFileSync(resolve('scripts/sync-harness.mjs'), 'utf8'),
    /--filter=blob:none[\s\S]*--sparse/,
  );
});

test('browser WebGPU project bounds workers to protect the shared device', () => {
  const browserProject = vitestConfig.slice(vitestConfig.indexOf("name: 'browser'"));
  assert.match(browserProject, /maxWorkers: 2/);
});

test('coverage-pnpm uploads diagnostics only after a failed test run', () => {
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
  assert.equal(uploadWithRetry.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length, 3);
  assert.equal(
    (workflow.match(/uses: \.\/\.github\/actions\/upload-optional-artifact/g) ?? []).length,
    4,
  );
  assert.equal(
    (
      workflow.match(
        /uses: \.\/\.github\/actions\/upload-optional-artifact\n\s+timeout-minutes: 2/g,
      ) ?? []
    ).length,
    4,
  );
});
