import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  codemodCommandWithoutAssertion,
  contextJob,
  encodeLocalProvenancePayload,
  executionPlan,
  extractRunCommands,
  extractRunSteps,
  isLocalCiArtifactOutput,
  isLocalCodemodIdempotencyAssertion,
  isLocalDependencyAssertion,
  isLocalShardArtifactsDownload,
  isLocalShardDdcDownload,
  isLocalShardReportsDownload,
  isLocalSharedInputsDownload,
  isLocalSharedProvenanceDownload,
  isLocalSharedProvenanceOutput,
  isLocalWebkitStatusDownload,
  isMatrixStepEnabled,
  isolateLocalCiArtifactsForLint,
  isRunnerProvisioning,
  jobDependencies,
  jobEnvironment,
  localGitHubFilePaths,
  localGitHubRuntime,
  localizeDarwinXvfb,
  localizeRunnerProvisioning,
  localShardArtifactPath,
  localShardReportPaths,
  localSharedProvenancePaths,
  localTargets,
  matrixCombinations,
  needsGitHubEnvironment,
  needsGitHubOutput,
  needsLocalArtifactIsolation,
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
const localVerifySource = readFileSync(resolve(root, 'scripts/ci/local-verify.mjs'), 'utf8');
const githubExpression = (value) => ['$', '{{ ', value, ' }}'].join('');

test('local PR CI projection scopes GITHUB_ENV to one job or matrix leg', () => {
  const planLoop = localVerifySource.indexOf('for (const plan of plans)');
  const environment = localVerifySource.indexOf('const githubEnvironment = {};', planLoop);
  const stepLoop = localVerifySource.indexOf('for (const step of plan.steps)', planLoop);
  assert.ok(planLoop >= 0);
  assert.ok(environment > planLoop && environment < stepLoop);
  assert.equal(localVerifySource.lastIndexOf('const githubEnvironment = {};'), environment);
});

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
  assert.deepEqual(jobEnvironment(appShard), {});
  for (const target of localTargets(workflow)) {
    assert.ok(workflow.includes(`  ${target}:`));
  }
  assert.equal(isRunnerProvisioning('echo "$RUNNER_TEMP" >> "$GITHUB_PATH"'), true);
  assert.equal(isRunnerProvisioning('nproc && cat /proc/cpuinfo'), true);
  const typecheckWithPathSetup = [
    'echo "$PWD/node_modules/typescript/bin" >> "$GITHUB_PATH"',
    'echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"',
    'export PATH="$PWD/node_modules/typescript/bin:$PWD/node_modules/.bin:$PATH"',
    'pnpm run typecheck',
  ].join('\n');
  assert.equal(isRunnerProvisioning(typecheckWithPathSetup), false);
  assert.equal(
    isRunnerProvisioning(
      String.raw`apt_wrapper="\${GITHUB_WORKSPACE}/scripts/ci/with-apt-ubuntu-sources.sh"
"$apt_wrapper" node node_modules/playwright/cli.js install-deps webkit`,
    ),
    true,
  );
  assert.equal(
    localizeRunnerProvisioning(typecheckWithPathSetup),
    'export PATH="$PWD/node_modules/typescript/bin:$PWD/node_modules/.bin:$PATH"\npnpm run typecheck',
  );
  const headedBrowser = 'xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 pnpm test:browser';
  assert.equal(
    localizeDarwinXvfb(headedBrowser, 'darwin'),
    'env CI=1 FORGEAX_BROWSER_HEADLESS=1 pnpm test:browser',
  );
  assert.equal(localizeDarwinXvfb(headedBrowser, 'linux'), headedBrowser);
  assert.equal(localizeDarwinXvfb('echo xvfb-run -a', 'darwin'), 'echo xvfb-run -a');
  assert.equal(
    localizeDarwinXvfb(
      'node scripts/ci/run-browser-gate-with-retry.mjs --mode=vitest -- xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 pnpm test:browser',
      'darwin',
    ),
    'node scripts/ci/run-browser-gate-with-retry.mjs --mode=vitest -- env CI=1 FORGEAX_BROWSER_HEADLESS=1 pnpm test:browser',
  );
  assert.equal(
    localizeDarwinXvfb('xvfb-run -a pnpm test:browser', 'darwin'),
    'env CI=1 FORGEAX_BROWSER_HEADLESS=1 pnpm test:browser',
  );
  const workflowXvfbCommands = extractRunSteps(workflow)
    .map((step) => step.command)
    .filter((command) => command.includes('xvfb-run -a'));
  assert.ok(workflowXvfbCommands.length > 0);
  assert.ok(
    workflowXvfbCommands.every((command) => {
      const localized = localizeDarwinXvfb(command, 'darwin');
      return (
        !localized.includes('xvfb-run') && localized.includes('CI=1 FORGEAX_BROWSER_HEADLESS=1')
      );
    }),
  );
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
    producerRunAttempt: 7,
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
    producerRunAttempt: 1,
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
    'node scripts/ci/build-shared-app-inputs.mjs --root . --out shared-app-inputs --github-output "$GITHUB_OUTPUT"';
  assert.equal(isRunnerProvisioning(sharedInputs), false);
  assert.equal(needsGitHubOutput(sharedInputs), true);
  assert.deepEqual(localGitHubFilePaths(sharedInputs, '/tmp/forgeax-ci'), {
    GITHUB_OUTPUT: '/tmp/forgeax-ci/step-output.txt',
  });
  const nodeOutput = [
    'fs.appendFileSync(process.env.GITHUB_OUTPUT, `payload=',
    '$',
    '{payload}',
    '\\n`)',
  ].join('');
  assert.equal(needsGitHubOutput(nodeOutput), true);
  assert.deepEqual(localGitHubFilePaths(nodeOutput, '/tmp/forgeax-ci'), {
    GITHUB_OUTPUT: '/tmp/forgeax-ci/step-output.txt',
  });
  assert.equal(needsStepSummary('process.env.GITHUB_STEP_SUMMARY'), true);
  assert.equal(needsGitHubEnvironment('process.env.GITHUB_ENV'), true);
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
  const provenanceRoot = mkdtempSync(join(tmpdir(), 'forgeax-local-provenance-'));
  try {
    const source = join(provenanceRoot, 'record.json');
    const record = { producer: 'core-build', producerRunAttempt: 7 };
    writeFileSync(source, `${JSON.stringify(record)}\n`);
    assert.deepEqual(
      JSON.parse(Buffer.from(encodeLocalProvenancePayload(source), 'base64').toString('utf8')),
      record,
    );
  } finally {
    rmSync(provenanceRoot, { recursive: true, force: true });
  }
  assert.equal(
    substituteLocalNeedsOutputs(
      `payload=${githubExpression('needs.core-build.outputs.provenance_payload')}`,
      '7',
      new Map([['core-build', { provenance_payload: 'encoded-core' }]]),
    ),
    'payload=encoded-core',
  );
  assert.equal(
    substituteLocalStepOutputs(
      `id=${githubExpression('steps.upload-core-build.outputs.artifact-id')} payload=${githubExpression('steps.write-core-provenance.outputs.payload')}`,
      localGitHubRuntime({ GITHUB_RUN_ATTEMPT: '7' }),
      new Map([['write-core-provenance', { payload: 'encoded-core' }]]),
    ),
    'id=local-core-build-a7 payload=encoded-core',
  );
  assert.equal(
    substituteLocalStepOutputs(
      githubExpression('steps.upload-shared-inputs.outputs.artifact-id'),
      localGitHubRuntime({ GITHUB_RUN_ATTEMPT: '1' }),
    ),
    'local-shared-app-inputs-a1',
  );
  const uploadRuntime = localGitHubRuntime({ GITHUB_RUN_ATTEMPT: '7' });
  assert.deepEqual(
    [
      'artifact-id',
      'artifact-name',
      'upload-started-at',
      'upload-completed-at',
      'upload-elapsed-seconds',
      'upload-transfer-attempt',
    ].map((output) =>
      substituteLocalStepOutputs(
        githubExpression(`steps.upload-app-dist-2.outputs.${output}`),
        uploadRuntime,
      ),
    ),
    [
      'local-app-dist-2-a7',
      'app-dist-2-a7',
      '1970-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '0',
      '1',
    ],
  );
  const sharedProvenanceDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.shared-app-inputs.outputs.provenance_artifact_id')}" --path provenance-records`;
  assert.equal(isLocalSharedProvenanceDownload(sharedProvenanceDownload), true);
  assert.equal(
    isLocalSharedProvenanceDownload('node scripts/ci/download-artifact-with-retry.mjs --path .'),
    false,
  );
  const sharedInputsDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.shared-app-inputs.outputs.shared_artifact_id')}" --path shared-app-inputs`;
  assert.equal(isLocalSharedInputsDownload(sharedInputsDownload), true);
  assert.equal(isLocalSharedInputsDownload(sharedProvenanceDownload), false);
  const shardReportsDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.app-shard-0.outputs.app_report_artifact_id')},${githubExpression('needs.app-shard-1.outputs.app_report_artifact_id')},${githubExpression('needs.app-shard-2.outputs.app_report_artifact_id')}" --path shard-reports`;
  assert.equal(isLocalShardReportsDownload(shardReportsDownload), true);
  assert.equal(
    isLocalShardArtifactsDownload(
      shardReportsDownload
        .replaceAll('app_report_artifact_id', 'app_dist_artifact_id')
        .replace('--path shard-reports', '--path .'),
    ),
    true,
  );
  const shardDdcDownload = `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.app-shard-0.outputs.app_ddc_artifact_id')},${githubExpression('needs.app-shard-1.outputs.app_ddc_artifact_id')},${githubExpression('needs.app-shard-2.outputs.app_ddc_artifact_id')}" --path ddc-snapshots`;
  assert.equal(isLocalShardDdcDownload(shardDdcDownload), true);
  assert.equal(
    isLocalShardArtifactsDownload(
      `node scripts/ci/download-artifact-with-retry.mjs --artifact-ids "${githubExpression('needs.build-artifacts.outputs.artifact_ids_primary_pnpm')}" --path .`,
    ),
    true,
  );
  assert.equal(isLocalShardArtifactsDownload(shardReportsDownload), false);
  assert.equal(isLocalShardReportsDownload(sharedProvenanceDownload), false);
  assert.equal(
    isLocalWebkitStatusDownload(
      `artifact_id='${githubExpression('needs.webkit-fallback.outputs.webkit_status_artifact_id')}'\nnode scripts/ci/download-artifact-with-retry.mjs --artifact-ids "$artifact_id" --path report/color-lighting-parity`,
    ),
    true,
  );
  assert.deepEqual(localSharedProvenancePaths('/repo', '7'), {
    source: '/repo/provenance-shared-app-inputs-a7.json',
    destination: '/repo/provenance-records/provenance-shared-app-inputs-a7.json',
  });
  assert.deepEqual(localShardReportPaths('/repo'), {
    source: '/repo/shard-report-transfer/report',
    destination: '/repo/shard-reports/report',
  });
  assert.equal(localShardArtifactPath('/tmp/local-ci', 2), '/tmp/local-ci/app-shard-2');
});

test('local artifact isolation hides runner outputs for both lint entrypoints and restores them', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-local-provenance-'));
  const numeric = 'provenance-shared-app-inputs-a1.json';
  const numericContents = JSON.stringify({
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    runId: 'local',
    producerRunAttempt: 1,
    artifacts: [{ artifactName: 'shared-app-inputs-a1', artifactId: 'local-shared-app-inputs-a1' }],
  });
  const appFingerprints = 'app-dist-0-fingerprints.json';
  const appFingerprintContents = JSON.stringify({
    'app-dist-0': `sha256:${'a'.repeat(64)}`,
  });
  const coreProvenance = 'provenance-core-build-a1.json';
  const coreProvenanceContents = JSON.stringify({
    schemaVersion: 1,
    producer: 'core-build',
    runId: 'local',
    producerRunAttempt: 1,
  });
  const sharedFingerprints = 'shared-input-fingerprints.json';
  const sharedFingerprintContents = JSON.stringify({
    'shared-asset-pack': `sha256:${'b'.repeat(64)}`,
    'shared-engine-shaders': `sha256:${'c'.repeat(64)}`,
  });
  try {
    writeFileSync(join(fixture, numeric), numericContents);
    writeFileSync(join(fixture, 'provenance-user.json'), '{"kept":true}');
    writeFileSync(join(fixture, appFingerprints), appFingerprintContents);
    writeFileSync(join(fixture, coreProvenance), coreProvenanceContents);
    writeFileSync(join(fixture, sharedFingerprints), sharedFingerprintContents);

    const restore = isolateLocalCiArtifactsForLint(fixture);
    assert.equal(existsSync(join(fixture, numeric)), false);
    assert.equal(existsSync(join(fixture, appFingerprints)), false);
    assert.equal(existsSync(join(fixture, coreProvenance)), false);
    assert.equal(existsSync(join(fixture, sharedFingerprints)), false);
    assert.equal(existsSync(join(fixture, 'provenance-user.json')), true);
    restore();

    assert.equal(readFileSync(join(fixture, numeric), 'utf8'), numericContents);
    assert.equal(readFileSync(join(fixture, appFingerprints), 'utf8'), appFingerprintContents);
    assert.equal(readFileSync(join(fixture, coreProvenance), 'utf8'), coreProvenanceContents);
    assert.equal(
      readFileSync(join(fixture, sharedFingerprints), 'utf8'),
      sharedFingerprintContents,
    );
    assert.equal(isLocalCiArtifactOutput('app-dist-0-fingerprints.json', {}), false);
    assert.equal(needsLocalArtifactIsolation('pnpm run lint'), true);
    assert.equal(needsLocalArtifactIsolation('bunx biome ci .'), true);
    assert.equal(needsLocalArtifactIsolation('bun run lint:internal'), false);
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

test('CI runs the engine-template browser smoke with the headed WebGPU Chrome Beta channel', () => {
  const start = workflow.indexOf('  shared-inputs-browser:');
  const end = workflow.indexOf('\n  smoke-fleet:', start);
  const step = extractRunSteps(workflow.slice(start, end)).find(
    (candidate) =>
      candidate.command ===
      'xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 pnpm --filter @forgeax/preview smoke:templates',
  );
  assert.ok(step, 'shared-inputs-browser must run the headed engine-template Preview smoke');
  assert.equal(step.environment.FORGEAX_CHROME_CHANNEL, 'chrome-beta');
});

test('local PR CI projection runs the owned WebKit dev-server step and carries its URL', () => {
  const start = workflow.indexOf('  webkit-fallback:');
  const end = workflow.indexOf('\n  portability-bun:', start);
  const step = extractRunSteps(workflow.slice(start, end)).find(
    (candidate) =>
      candidate.command.includes('node scripts/ci/owned-dev-server.mjs start') &&
      candidate.command.includes('report/ci-lifecycle/hello-triangle.json'),
  );
  assert.ok(step);
  assert.equal(needsGitHubEnvironment(step.command), true);
  assert.equal(isRunnerProvisioning(step.command), false);
  assert.deepEqual(localGitHubFilePaths(step.command, '/tmp/forgeax-ci'), {
    GITHUB_ENV: '/tmp/forgeax-ci/step-environment.txt',
  });
  assert.deepEqual(readLocalGitHubEnvironment('DEV_SERVER_URL=http://127.0.0.1:5181/\n'), {
    DEV_SERVER_URL: 'http://127.0.0.1:5181/',
  });
  const verifyStep = extractRunSteps(workflow.slice(start, end)).find(
    (candidate) =>
      candidate.command ===
      'DEV_SERVER_URL="$DEV_SERVER_URL" node scripts/dev-verify/verify-webkit-r5-stability.mjs',
  );
  assert.ok(verifyStep);
  assert.deepEqual(verifyStep.environment, {
    TIMEOUT_MS: '120000',
    SCREENSHOT_A: '/tmp/r5-over-capacity-webkit.png',
    SCREENSHOT_B: '/tmp/r5-bad-submit-webkit.png',
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
    'pnpm bevy:smokes -- --group 0 --groups 3 --concurrency auto',
    'pnpm bevy:smokes -- --group 1 --groups 3 --concurrency auto',
    'pnpm bevy:smokes -- --group 2 --groups 3 --concurrency auto',
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

test('M4-T1: workflow evidence wiring preserves execution and payload boundaries', () => {
  const job = (name, next) =>
    workflow.slice(workflow.indexOf(`  ${name}:`), workflow.indexOf(`\n  ${next}:`));
  const core = job('core-build', 'shared-app-inputs');
  const shared = job('shared-app-inputs', 'shared-evidence-probe');
  const shard0 = job('app-shard-0', 'app-shard-1');
  const shard1 = job('app-shard-1', 'app-shard-2');
  const shard2 = job('app-shard-2', 'build-artifacts');
  const buildArtifacts = job('build-artifacts', 'cache-warm');
  const bevy = job('bevy-smoke-fleet', 'bevy-smoke-fleet-required-context');

  assert.match(
    workflow,
    /concurrency:[\s\S]*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}[\s\S]*cancel-in-progress: true/,
  );
  for (const block of [core, shared, shard0, shard1, shard2, buildArtifacts]) {
    assert.match(
      block,
      /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "standard"\]'\) \}\}/,
    );
  }
  assert.deepEqual(jobDependencies(workflow, 'build-artifacts'), [
    'core-build',
    'shared-app-inputs',
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ]);
  assert.deepEqual(jobDependencies(workflow, 'cache-warm'), [
    'app-shard-0',
    'app-shard-1',
    'app-shard-2',
  ]);

  assert.match(
    core,
    /name: core-build-a\$\{\{ github\.run_attempt \}\}[\s\S]*path: ci-artifacts\/core/,
  );
  assert.match(
    shared,
    /name: shared-app-inputs-a\$\{\{ github\.run_attempt \}\}[\s\S]*path: \|\n\s+shared-app-inputs\/assets\n\s+shared-app-inputs\/shaders\n\s+shared-app-inputs\/manifest\.json/,
  );
  assert.doesNotMatch(shared, /shared-app-inputs-full|shared-app-inputs-shard/);
  for (const [index, block] of [shard0, shard1, shard2].entries()) {
    assert.match(
      block,
      new RegExp(`name: app-dist-${index}-a\\$\\{\\{ github\\.run_attempt \\}\\}`),
    );
    assert.match(block, /path: shard-transfer/);
    assert.match(block, /producerRunAttempt: attempt/);
    assert.doesNotMatch(block, /producerRunAttempt:\s*Number\('\$\{\{/);
  }

  assert.match(bevy, /matrix:\n\s+group: \[0, 1, 2\]/);
  assert.match(
    bevy,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.match(bevy, /timeout-minutes: 45/);
  assert.match(bevy, /SMOKE_MIN_FRAMES: 100/);
  assert.match(bevy, /SMOKE_DURATION_MS: 1667/);
  assert.match(
    bevy,
    /pnpm bevy:smokes -- --group \$\{\{ matrix\.group \}\} --groups 3 --concurrency auto/,
  );
});
