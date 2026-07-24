import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  contextJob,
  extractJobEnv,
  extractRunCommands,
  extractRunSteps,
  isHostLimitedJob,
  isPathFiltered,
  isRunnerProvisioning,
  jobDependencies,
  localTargets,
  projectGithubExpressions,
  requiredContexts,
  targetsForGroup,
} from '../local-verify.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test('local PR CI projection covers every required context and maps matrix legs to their workflow job', () => {
  const contexts = requiredContexts();
  assert.ok(contexts.includes('smoke-fleet-0'));
  assert.ok(contexts.includes('bevy-smoke-fleet-2'));
  assert.equal(contextJob('smoke-fleet'), 'smoke-fleet-required-context');
  assert.equal(contextJob('smoke-fleet-1'), 'smoke-fleet');
  assert.equal(contextJob('bevy-smoke-fleet-2'), 'bevy-smoke-fleet');
  assert.equal(contextJob('primary-pnpm'), 'primary-pnpm');
  for (const target of [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ]) {
    assert.ok(localTargets(workflow).includes(target));
  }
  assert.deepEqual(targetsForGroup('smoke-fleet-1', workflow), [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
    'build-artifacts',
    'post-merge-gate',
    'smoke-fleet',
  ]);
  assert.deepEqual(jobDependencies(workflow, 'build-artifacts'), [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ]);
  for (const target of localTargets(workflow)) {
    assert.ok(workflow.includes(`  ${target}:`));
  }
  assert.equal(isRunnerProvisioning('echo "$RUNNER_TEMP" >> "$GITHUB_PATH"'), true);
  assert.equal(isRunnerProvisioning('nproc && cat /proc/cpuinfo'), true);
  assert.equal(isRunnerProvisioning('nohup pnpm dev > /tmp/dev-server.log 2>&1 &'), false);
  assert.equal(
    isPathFiltered('SKIP_BUN_INSTALL=1 bash scripts/codemod/rename-engine-family.sh'),
    true,
  );
  assert.equal(isHostLimitedJob('webkit-fallback'), process.platform === 'darwin');
  assert.equal(
    isRunnerProvisioning(
      'node scripts/ci/build-shared-app-inputs.mjs --github-output "$GITHUB_OUTPUT"',
    ),
    false,
  );
  assert.equal(
    projectGithubExpressions(`test '\${{ needs.core-build.result }}' = success`),
    "test 'success' = success",
  );
  assert.equal(
    projectGithubExpressions(`--id "\${{ needs.core-build.outputs.core_artifact_id }}"`),
    '--id "local-core-build-core_artifact_id"',
  );
  assert.equal(
    projectGithubExpressions('--group $' + '{{ matrix.group }} --groups 3'),
    '--group 0 --groups 3',
  );
});

test('local PR CI projection extracts workflow shell commands rather than a copied smoke ledger', () => {
  const start = workflow.indexOf('  smoke-fleet:');
  const end = workflow.indexOf('\n  smoke-fleet-required-context:', start);
  const commands = extractRunCommands(workflow.slice(start, end));
  assert.ok(commands.includes('pnpm --filter @forgeax/hello-triangle smoke'));
  assert.equal(
    commands.some((command) => command.includes('@forgeax/hello-custom-shader smoke')),
    true,
  );
});

test('local PR CI projection preserves explicit workflow shells and environment', () => {
  const start = workflow.indexOf('  shared-app-inputs:');
  const end = workflow.indexOf('\n  shared-evidence-probe:', start);
  const steps = extractRunSteps(workflow.slice(start, end));
  const provenance = steps.find((step) => step.command.includes("require('node:fs')"));

  assert.equal(provenance?.shell, 'node {0}');
  const appShardStart = workflow.indexOf('  app-shard-0:');
  const appShardEnd = workflow.indexOf('\n  app-shard-1:', appShardStart);
  assert.deepEqual(extractJobEnv(workflow.slice(appShardStart, appShardEnd)), {
    FORGEAX_SHARED_APP_INPUTS_MODE: 'catalog-only',
  });
  const aggregateStart = workflow.indexOf('  smoke-fleet-required-context:');
  const aggregateEnd = workflow.indexOf('\n  bevy-smoke-fleet:', aggregateStart);
  const aggregateStep = extractRunSteps(workflow.slice(aggregateStart, aggregateEnd)).find(
    ({ command }) => command.includes('MATRIX_RESULT'),
  );
  assert.deepEqual(aggregateStep?.env, { MATRIX_RESULT: '$' + '{{ needs.smoke-fleet.result }}' });
});
