import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  codemodCommandWithoutAssertion,
  contextJob,
  executionPlan,
  extractRunCommands,
  extractRunSteps,
  isLocalCodemodIdempotencyAssertion,
  isLocalDependencyAssertion,
  isLocalShardReportsDownload,
  isLocalSharedProvenanceDownload,
  isLocalSharedProvenanceOutput,
  isMatrixStepEnabled,
  isolateLocalProvenanceForLint,
  isRunnerProvisioning,
  jobDependencies,
  jobEnvironment,
  localGitHubFilePaths,
  localGitHubRuntime,
  localShardReportPaths,
  localSharedProvenancePaths,
  localTargets,
  matrixCombinations,
  needsGitHubEnvironment,
  needsGitHubOutput,
  needsLocalProvenanceIsolation,
  needsStepSummary,
  plansFor,
  readLocalGitHubEnvironment,
  requiredContexts,
  substituteLocalMatrix,
  substituteLocalNeedsOutputs,
  substituteLocalNeedsResults,
  substituteLocalStepOutputs,
  targetsForGroup,
} from '../local-verify.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const githubExpression = (value) => ['$', '{{ ', value, ' }}'].join('');

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
  const appShard = workflow.slice(
    workflow.indexOf('  app-shard-0:'),
    workflow.indexOf('\n  app-shard-1:', workflow.indexOf('  app-shard-0:')),
  );
  assert.deepEqual(jobEnvironment(appShard), { FORGEAX_SHARED_APP_INPUTS_MODE: 'catalog-only' });
  for (const target of localTargets(workflow)) {
    assert.ok(workflow.includes(`  ${target}:`));
  }
  assert.equal(isRunnerProvisioning('echo "$RUNNER_TEMP" >> "$GITHUB_PATH"'), true);
  assert.equal(isRunnerProvisioning('nproc && cat /proc/cpuinfo'), true);
  assert.equal(
    isLocalDependencyAssertion(
      `test '${githubExpression('needs.core-build.result')}' = success\ntest '${githubExpression('needs.app-shard-0.result')}' = success`,
    ),
    true,
  );
  assert.equal(
    isLocalDependencyAssertion(`test '${githubExpression('needs.core-build.result')}' = failure`),
    false,
  );
  assert.equal(
    isLocalDependencyAssertion(`test "${githubExpression('github.event_name')}" = pull_request`),
    false,
  );
  const codemodIdempotency =
    "SKIP_BUN_INSTALL=1 bash scripts/codemod/rename-engine-family.sh\ngit diff --quiet -- . ':!packages/*/pkg/**'";
  assert.equal(isLocalCodemodIdempotencyAssertion(codemodIdempotency), true);
  assert.equal(isLocalCodemodIdempotencyAssertion('git diff --quiet -- .'), false);
  assert.equal(
    codemodCommandWithoutAssertion(codemodIdempotency),
    'SKIP_BUN_INSTALL=1 bash scripts/codemod/rename-engine-family.sh',
  );
  const localProvenance = {
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    runId: 'local',
    runAttempt: 7,
    artifacts: [{ artifactName: 'shared-app-inputs-a7', artifactId: 'local-shared-app-inputs-a7' }],
  };
  assert.equal(
    isLocalSharedProvenanceOutput('provenance-shared-app-inputs-a7.json', localProvenance),
    true,
  );
  assert.equal(
    isLocalSharedProvenanceOutput('provenance-shared-app-inputs-a7.json', {
      ...localProvenance,
      runId: 'remote',
    }),
    false,
  );
  const unresolvedLocalProvenance = {
    ...localProvenance,
    runAttempt: 1,
    artifacts: [
      {
        artifactName: 'shared-app-inputs-a1',
        artifactId: githubExpression('steps.upload-shared-inputs.outputs.artifact-id'),
      },
    ],
  };
  assert.equal(
    isLocalSharedProvenanceOutput(
      'provenance-shared-app-inputs-a1.json',
      unresolvedLocalProvenance,
    ),
    true,
  );
  const sharedInputs =
    'node scripts/ci/build-shared-app-inputs.mjs --root . --out shared-app-inputs --catalog-only --github-output "$GITHUB_OUTPUT"';
  assert.equal(isRunnerProvisioning(sharedInputs), false);
  assert.equal(needsGitHubOutput(sharedInputs), true);
  assert.deepEqual(localGitHubFilePaths(sharedInputs, '/tmp/forgeax-ci'), {
    GITHUB_OUTPUT: '/tmp/forgeax-ci/step-output.txt',
  });
  assert.deepEqual(localGitHubRuntime({}), {
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: 'local',
    SHARED_ARTIFACT_ID: 'local-shared-app-inputs-a1',
  });
  assert.deepEqual(localGitHubRuntime({ GITHUB_RUN_ATTEMPT: '7', GITHUB_RUN_ID: 'caller-run' }), {
    GITHUB_RUN_ATTEMPT: '7',
    GITHUB_RUN_ID: 'caller-run',
    SHARED_ARTIFACT_ID: 'local-shared-app-inputs-a7',
  });
  assert.equal(
    substituteLocalNeedsOutputs(
      `name=${githubExpression('needs.core-build.outputs.core_artifact_name')} id=${githubExpression('needs.app-shard-2.outputs.app_dist_artifact_id')}`,
      '7',
    ),
    'name=core-build-a7 id=local-app-dist-2-a7',
  );
  assert.equal(
    substituteLocalNeedsOutputs(
      `keep=${githubExpression('needs.unknown.outputs.value')} context=${githubExpression('github.run_id')}`,
    ),
    `keep=${githubExpression('needs.unknown.outputs.value')} context=${githubExpression('github.run_id')}`,
  );
  assert.equal(
    substituteLocalStepOutputs(
      githubExpression('steps.upload-shared-inputs.outputs.artifact-id'),
      localGitHubRuntime({ GITHUB_RUN_ATTEMPT: '1' }),
    ),
    'local-shared-app-inputs-a1',
  );
  const sharedProvenanceDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.shared-app-inputs.outputs.provenance_artifact_id')}" --path provenance-records`;
  assert.equal(isLocalSharedProvenanceDownload(sharedProvenanceDownload), true);
  assert.equal(
    isLocalSharedProvenanceDownload('node scripts/ci/download-artifact-with-retry.mjs --path .'),
    false,
  );
  const shardReportsDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.app-shard-0.outputs.app_dist_artifact_id')},${githubExpression('needs.app-shard-1.outputs.app_dist_artifact_id')},${githubExpression('needs.app-shard-2.outputs.app_dist_artifact_id')}" --path shard-reports`;
  assert.equal(isLocalShardReportsDownload(shardReportsDownload), true);
  assert.equal(isLocalShardReportsDownload(sharedProvenanceDownload), false);
  assert.deepEqual(localSharedProvenancePaths('/repo', '7'), {
    source: '/repo/provenance-shared-app-inputs-a7.json',
    destination: '/repo/provenance-records/provenance-shared-app-inputs-a7.json',
  });
  assert.deepEqual(localShardReportPaths('/repo'), {
    source: '/repo/shard-transfer/report',
    destination: '/repo/shard-reports/report',
  });
});

test('local provenance isolation hides runner outputs for both lint entrypoints and restores them', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-local-provenance-'));
  const numeric = 'provenance-shared-app-inputs-a1.json';
  const unresolved = 'provenance-shared-app-inputs-aNaN.json';
  const numericContents = JSON.stringify({
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    runId: 'local',
    runAttempt: 1,
    artifacts: [{ artifactName: 'shared-app-inputs-a1', artifactId: 'local-shared-app-inputs-a1' }],
  });
  const unresolvedContents = JSON.stringify({
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    runAttempt: null,
    artifacts: [{ artifactName: 'shared-app-inputs-aNaN' }],
  });
  try {
    writeFileSync(join(fixture, numeric), numericContents);
    writeFileSync(join(fixture, unresolved), unresolvedContents);
    writeFileSync(join(fixture, 'provenance-user.json'), '{"kept":true}');

    const restore = isolateLocalProvenanceForLint(fixture);
    assert.equal(existsSync(join(fixture, numeric)), false);
    assert.equal(existsSync(join(fixture, unresolved)), false);
    assert.equal(existsSync(join(fixture, 'provenance-user.json')), true);
    restore();

    assert.equal(readFileSync(join(fixture, numeric), 'utf8'), numericContents);
    assert.equal(readFileSync(join(fixture, unresolved), 'utf8'), unresolvedContents);
    assert.equal(needsLocalProvenanceIsolation('pnpm run lint'), true);
    assert.equal(needsLocalProvenanceIsolation('bunx biome ci .'), true);
    assert.equal(needsLocalProvenanceIsolation('bun run lint:internal'), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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

test('local PR CI projection runs the WebKit dev-server step and carries its PID', () => {
  const start = workflow.indexOf('  webkit-fallback:');
  const end = workflow.indexOf('\n  portability-bun:', start);
  const step = extractRunSteps(workflow.slice(start, end)).find((candidate) =>
    candidate.command.includes('nohup pnpm dev'),
  );
  assert.ok(step);
  assert.equal(needsGitHubEnvironment(step.command), true);
  assert.equal(isRunnerProvisioning(step.command), false);
  assert.deepEqual(localGitHubFilePaths(step.command, '/tmp/forgeax-ci'), {
    GITHUB_ENV: '/tmp/forgeax-ci/step-environment.txt',
  });
  assert.deepEqual(readLocalGitHubEnvironment('DEV_SERVER_PID=1234\n'), {
    DEV_SERVER_PID: '1234',
  });
  const verifyStep = extractRunSteps(workflow.slice(start, end)).find(
    (candidate) => candidate.command === 'node scripts/dev-verify/verify-webkit-hello-triangle.mjs',
  );
  assert.ok(verifyStep);
  assert.deepEqual(verifyStep.environment, {
    URL: 'http://localhost:5181/',
    TIMEOUT_MS: '25000',
    SCREENSHOT: '/tmp/hello-triangle-webkit.png',
  });
});

test('local PR CI projection expands the actual Bevy smoke matrix', () => {
  const block = workflow.slice(
    workflow.indexOf('  bevy-smoke-fleet:'),
    workflow.indexOf('\n  bevy-smoke-fleet-required-context:'),
  );
  assert.deepEqual(matrixCombinations(block), [{ group: '0' }, { group: '1' }, { group: '2' }]);
  const plans = plansFor('bevy-smoke-fleet', workflow);
  assert.deepEqual(
    plans.map((plan) => plan.matrix),
    [{ group: '0' }, { group: '1' }, { group: '2' }],
  );
  const smokeCommand = plans.map((plan) => {
    const step = plan.steps.find((candidate) => candidate.command.includes('pnpm bevy:smokes'));
    assert.ok(step);
    return substituteLocalMatrix(step.command, plan.matrix);
  });
  assert.deepEqual(smokeCommand, [
    'pnpm bevy:smokes -- --group 0 --groups 3',
    'pnpm bevy:smokes -- --group 1 --groups 3',
    'pnpm bevy:smokes -- --group 2 --groups 3',
  ]);
  assert.equal(isMatrixStepEnabled('matrix.group == 0', { group: '0' }), true);
  assert.equal(isMatrixStepEnabled('matrix.group == 0', { group: '1' }), false);
  assert.equal(isMatrixStepEnabled('matrix.group == 2 && failure()', { group: '2' }), false);
});

test('local PR CI projection carries matrix results through step-level environment', () => {
  const start = workflow.indexOf('  smoke-fleet-required-context:');
  const end = workflow.indexOf('\n  bevy-smoke-fleet:', start);
  const [step] = extractRunSteps(workflow.slice(start, end));
  assert.deepEqual(step.environment, {
    MATRIX_RESULT: githubExpression('needs.smoke-fleet.result'),
  });
  assert.equal(
    substituteLocalNeedsResults(
      step.environment.MATRIX_RESULT,
      new Map([['smoke-fleet', 'success']]),
    ),
    'success',
  );
  assert.equal(
    substituteLocalNeedsResults(
      step.environment.MATRIX_RESULT,
      new Map([['smoke-fleet', 'skipped']]),
    ),
    'skipped',
  );
  assert.throws(
    () => substituteLocalNeedsResults(step.environment.MATRIX_RESULT, new Map()),
    /ci-local-verify-needs-result-missing: jobs\.smoke-fleet/,
  );
});

test('core artifact-size summary uses macOS Bash 3.2-compatible indexed arrays', () => {
  const start = workflow.indexOf('  core-build:');
  const end = workflow.indexOf('\n  shared-app-inputs:', start);
  const command = extractRunCommands(workflow.slice(start, end)).find((value) =>
    value.includes('TOTAL_KB=0'),
  );
  assert.ok(command);
  assert.match(command, /CLASS_NAMES=\(/);
  assert.match(command, /CLASS_GLOBS=\(/);
  assert.match(command, /for INDEX in "\$\{!CLASS_NAMES\[@\]\}"/);
  assert.doesNotMatch(command, /declare -A/);
});

test('local PR CI projection retains each step shell and plans GitHub-compatible execution', () => {
  const steps = extractRunSteps(`
      - name: Default shell
        run: echo default
      - name: Bash features
        shell: bash
        run: |
          shopt -s nullglob
          echo "$GITHUB_STEP_SUMMARY"
      - name: Node script
        shell: node {0}
        run: |
          const value = 1;
          process.exit(value - 1);
`);
  assert.deepEqual(steps, [
    { command: 'echo default', shell: undefined },
    { command: 'shopt -s nullglob\necho "$GITHUB_STEP_SUMMARY"', shell: 'bash' },
    { command: 'const value = 1;\nprocess.exit(value - 1);', shell: 'node {0}' },
  ]);
  assert.deepEqual(executionPlan(steps[0]), {
    executable: 'bash',
    args: ['-e', '-c', 'echo default'],
  });
  assert.deepEqual(executionPlan(steps[1]), {
    executable: 'bash',
    args: [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      'shopt -s nullglob\necho "$GITHUB_STEP_SUMMARY"',
    ],
  });
  assert.deepEqual(executionPlan(steps[2]), {
    executable: 'node',
    args: ['-e', 'const value = 1;\nprocess.exit(value - 1);'],
  });
  assert.equal(needsStepSummary(steps[1].command), true);
  assert.equal(needsStepSummary('echo no-summary'), false);
  assert.deepEqual(localGitHubFilePaths(steps[1].command, '/tmp/forgeax-ci'), {
    GITHUB_STEP_SUMMARY: '/tmp/forgeax-ci/step-summary.md',
  });
});
