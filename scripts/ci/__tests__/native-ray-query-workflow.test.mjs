import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(
  import.meta.dirname,
  '../../../.github/workflows/native-ray-query.yml',
);

test('native ray query installs the C linker toolchain before cargo gates', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const prerequisiteStart = workflow.indexOf('      - name: Install native desktop prerequisites');
  const prerequisiteEnd = workflow.indexOf(
    '      - name: Install workspace dependencies',
    prerequisiteStart,
  );
  const prerequisite = workflow.slice(prerequisiteStart, prerequisiteEnd);
  const cargoGate = workflow.indexOf(
    'cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml',
  );

  assert.notEqual(prerequisiteStart, -1, 'native prerequisite step must exist');
  assert.notEqual(prerequisiteEnd, -1, 'workspace install must follow native prerequisites');
  assert.match(prerequisite, /\bbuild-essential\b/);
  assert.ok(cargoGate > prerequisiteEnd, 'cargo gates must run after the toolchain step');
  assert.match(workflow, /cargo clippy --manifest-path packages\/rhi-wgpu-native\/Cargo\.toml/);
  assert.match(workflow, /pnpm --filter @forgeax\/native-ray-query-triangle-tauri build:desktop/);
});
