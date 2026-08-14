#!/usr/bin/env node
// Local projection of the required PR CI surface. The workflow remains the
// command SSOT: this runner extracts its shell steps instead of copying them.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const WORKFLOW = resolve(ROOT, '.github/workflows/ci.yml');
const REQUIRED = resolve(ROOT, 'scripts/ci/required-ci-checks.json');
const GITHUB_RUN_ATTEMPT = '$' + '{{ github.run_attempt }}';

const MATRIX_CONTEXTS = new Map([
  ['smoke-fleet', 'smoke-fleet-required-context'],
  ['smoke-fleet-0', 'smoke-fleet'],
  ['smoke-fleet-1', 'smoke-fleet'],
  ['smoke-fleet-2', 'smoke-fleet'],
  ['bevy-smoke-fleet', 'bevy-smoke-fleet-required-context'],
  ['bevy-smoke-fleet-0', 'bevy-smoke-fleet'],
  ['bevy-smoke-fleet-1', 'bevy-smoke-fleet'],
  ['bevy-smoke-fleet-2', 'bevy-smoke-fleet'],
]);

const NEEDS_RESULT = /\$\{\{ needs\.([a-zA-Z0-9_-]+)\.result \}\}/g;
const MATRIX_VALUE = /\$\{\{ matrix\.([a-zA-Z0-9_-]+) \}\}/g;
const SHARED_ARTIFACT_ID_EXPRESSION = '$' + '{{ steps.upload-shared-inputs.outputs.artifact-id }}';
const STEP_OUTPUT_EXPRESSION =
  /\$\{\{\s*steps\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_-]+)\s*\}\}/g;

const SETUP_ONLY = [
  /^echo "value=\$\(cat \.pnpm-version\)" >> \$GITHUB_OUTPUT$/,
  /^node scripts\/ci\/download-artifact-with-retry\.mjs\b/,
  /^node scripts\/ci\/verify-build-artifact-input\.mjs\b/,
  /^git config --global --unset-all /,
  /^sudo git config --system --unset-all /,
];

function jobBlock(workflow, job) {
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  if (start === -1)
    throw new Error(`ci-local-verify-job-missing: jobs.${job} is absent from ci.yml`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** Extract runnable workflow steps and the shell GitHub Actions assigns to each. */
export function extractRunSteps(block) {
  const lines = block.split(/\r?\n/);
  const steps = [];
  for (let start = 0; start < lines.length; ) {
    if (!/^ {6}- /.test(lines[start])) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !/^ {6}- /.test(lines[end])) end += 1;
    const step = lines.slice(start, end);
    const shell = step.map((line) => line.match(/^ {8}shell:\s*(.+)$/)?.[1].trim()).find(Boolean);
    const id = step.map((line) => line.match(/^ {8}id:\s*(.+)$/)?.[1].trim()).find(Boolean);
    const environment = stepEnvironment(step);
    const condition = step.map((line) => line.match(/^ {8}if:\s*(.+)$/)?.[1].trim()).find(Boolean);
    const runIndex = step.findIndex((line) => /^ {8}run: /.test(line));
    if (runIndex !== -1) {
      const value = step[runIndex].replace(/^ {8}run: /, '');
      const body = [];
      if (value === '|' || value === '>-') {
        for (let i = runIndex + 1; i < step.length && /^ {10}/.test(step[i]); i += 1) {
          body.push(step[i].slice(10));
        }
      }
      const command = (
        value === '|' ? body.join('\n') : value === '>-' ? body.join(' ') : value
      ).trim();
      if (command) {
        steps.push({
          command,
          shell,
          ...(id === undefined ? {} : { id: yamlScalar(id) }),
          ...(Object.keys(environment).length > 0 ? { environment } : {}),
          ...(condition ? { condition } : {}),
        });
      }
    }
    start = end;
  }
  return steps;
}

function stepEnvironment(step) {
  const start = step.findIndex((line) => /^ {8}env:\s*$/.test(line));
  if (start === -1) return {};
  const environment = {};
  for (let index = start + 1; index < step.length; index += 1) {
    const match = step[index].match(/^ {10}([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (match) {
      environment[match[1]] = yamlScalar(match[2]);
      continue;
    }
    if (step[index].trim() && !/^ {10}#/.test(step[index])) break;
  }
  return environment;
}

function yamlScalar(value) {
  const quoted = value.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : value;
}

/** Compatibility projection for callers interested only in command text. */
export function extractRunCommands(block) {
  return extractRunSteps(block).map((step) => step.command);
}

export function executionPlan(step) {
  if (step.shell === undefined) {
    return { executable: 'bash', args: ['-e', '-c', step.command] };
  }
  if (step.shell === 'bash') {
    return {
      executable: 'bash',
      args: ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.command],
    };
  }
  if (step.shell === 'node {0}') return { executable: 'node', args: ['-e', step.command] };
  throw new Error(`ci-local-verify-shell-unsupported: ${step.shell}`);
}

export function needsStepSummary(command) {
  return /\bGITHUB_STEP_SUMMARY\b/.test(command);
}

export function needsGitHubOutput(command) {
  return /\bGITHUB_OUTPUT\b/.test(command);
}

export function needsGitHubEnvironment(command) {
  return /\bGITHUB_ENV\b/.test(command);
}

export function localGitHubFilePaths(command, directory) {
  return {
    ...(needsStepSummary(command)
      ? { GITHUB_STEP_SUMMARY: resolve(directory, 'step-summary.md') }
      : {}),
    ...(needsGitHubOutput(command) ? { GITHUB_OUTPUT: resolve(directory, 'step-output.txt') } : {}),
    ...(needsGitHubEnvironment(command)
      ? { GITHUB_ENV: resolve(directory, 'step-environment.txt') }
      : {}),
  };
}

export function readLocalGitHubEnvironment(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

export function localGitHubRuntime(environment = {}) {
  const attempt = environment.GITHUB_RUN_ATTEMPT ?? '1';
  return {
    GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_RUN_ID: environment.GITHUB_RUN_ID ?? 'local',
    SHARED_ARTIFACT_ID: environment.SHARED_ARTIFACT_ID ?? `local-shared-app-inputs-a${attempt}`,
  };
}

export function isLocalSharedProvenanceDownload(command) {
  return (
    /^node scripts\/ci\/download-artifact-with-retry\.mjs\b/.test(command.trim()) &&
    /needs\.shared-app-inputs\.outputs\.provenance_artifact_id/.test(command) &&
    /--path provenance-records\b/.test(command)
  );
}

export function isLocalShardReportsDownload(command) {
  return (
    /^node scripts\/ci\/download-artifact-with-retry\.mjs\b/.test(command.trim()) &&
    /needs\.app-shard-0\.outputs\.app_dist_artifact_id/.test(command) &&
    /needs\.app-shard-1\.outputs\.app_dist_artifact_id/.test(command) &&
    /needs\.app-shard-2\.outputs\.app_dist_artifact_id/.test(command) &&
    /--path shard-reports\b/.test(command)
  );
}

export function localSharedProvenancePaths(root, attempt) {
  const name = `provenance-shared-app-inputs-a${attempt}.json`;
  return {
    source: resolve(root, name),
    destination: resolve(root, 'provenance-records', name),
  };
}

export function localShardReportPaths(root) {
  return {
    source: resolve(root, 'shard-transfer', 'report'),
    destination: resolve(root, 'shard-reports', 'report'),
  };
}

function provideLocalSharedProvenance(attempt) {
  const { source, destination } = localSharedProvenancePaths(ROOT, attempt);
  if (!existsSync(source)) {
    throw new Error(`ci-local-verify-shared-provenance-missing: ${source}`);
  }
  mkdirSync(resolve(ROOT, 'provenance-records'), { recursive: true });
  copyFileSync(source, destination);
}

function provideLocalShardReports() {
  const { source, destination } = localShardReportPaths(ROOT);
  if (!existsSync(source)) {
    throw new Error(`ci-local-verify-shard-reports-missing: ${source}`);
  }
  mkdirSync(resolve(ROOT, 'shard-reports'), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function outputValue(outputs, owner, name) {
  const values = outputs instanceof Map ? outputs.get(owner) : outputs?.[owner];
  return values?.[name];
}

function staticUploadOutput(step, output, attempt, runtime) {
  const artifactNames = {
    'upload-core-build': 'core-build',
    'upload-app-dist-0': 'app-dist-0',
    'upload-app-dist-1': 'app-dist-1',
    'upload-app-dist-2': 'app-dist-2',
    'upload-shared-inputs': 'shared-app-inputs',
    'upload-shared-provenance': 'shared-provenance',
    'upload-metrics-report': 'metrics-report',
    'upload-webkit-status': 'webkit-status',
  };
  const artifactName = artifactNames[step];
  if (artifactName === undefined) return undefined;
  const values = {
    'artifact-id':
      step === 'upload-shared-inputs'
        ? runtime.SHARED_ARTIFACT_ID
        : `local-${artifactName}-a${attempt}`,
    'artifact-name': `${artifactName}-a${attempt}`,
    'upload-started-at': '1970-01-01T00:00:00.000Z',
    'upload-completed-at': '1970-01-01T00:00:00.000Z',
    'upload-elapsed-seconds': '0',
    'upload-transfer-attempt': '1',
  };
  return values[output];
}

export function substituteLocalNeedsOutputs(command, attempt = '1', needsOutputs = new Map()) {
  const outputs = {
    'core-build.core_artifact_name': `core-build-a${attempt}`,
    'core-build.core_artifact_id': `local-core-build-a${attempt}`,
    'app-shard-0.app_dist_artifact_name': `app-dist-0-a${attempt}`,
    'app-shard-0.app_dist_artifact_id': `local-app-dist-0-a${attempt}`,
    'app-shard-1.app_dist_artifact_name': `app-dist-1-a${attempt}`,
    'app-shard-1.app_dist_artifact_id': `local-app-dist-1-a${attempt}`,
    'app-shard-2.app_dist_artifact_name': `app-dist-2-a${attempt}`,
    'app-shard-2.app_dist_artifact_id': `local-app-dist-2-a${attempt}`,
  };
  for (const producer of ['core-build', 'app-shard-0', 'app-shard-1', 'app-shard-2']) {
    const source = resolve(ROOT, `provenance-${producer}-a${attempt}.json`);
    if (existsSync(source)) {
      outputs[`${producer}.provenance_payload`] = encodeLocalProvenancePayload(source);
    }
  }
  return command.replace(
    /\$\{\{ needs\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+) \}\}/g,
    (expression, job, output) =>
      outputValue(needsOutputs, job, output) ?? outputs[`${job}.${output}`] ?? expression,
  );
}

export function encodeLocalProvenancePayload(source) {
  return readFileSync(source).toString('base64');
}

export function substituteLocalNeedsResults(value, results) {
  return value.replace(NEEDS_RESULT, (_expression, job) => {
    const result = results.get(job);
    if (!result) throw new Error(`ci-local-verify-needs-result-missing: jobs.${job}`);
    return result;
  });
}

export function substituteLocalMatrix(value, matrix) {
  return value.replace(MATRIX_VALUE, (_expression, key) => {
    const matrixValue = matrix[key];
    if (matrixValue === undefined)
      throw new Error(`ci-local-verify-matrix-value-missing: matrix.${key}`);
    return String(matrixValue);
  });
}

export function substituteLocalStepOutputs(value, runtime, stepOutputs = new Map()) {
  const attempt = runtime.GITHUB_RUN_ATTEMPT ?? '1';
  return value.replace(
    STEP_OUTPUT_EXPRESSION,
    (expression, step, output) =>
      outputValue(stepOutputs, step, output) ??
      staticUploadOutput(step, output, attempt, runtime) ??
      expression,
  );
}

export function contextJob(context) {
  return MATRIX_CONTEXTS.get(context) ?? context;
}

export function isSetupOnly(command) {
  return SETUP_ONLY.some((pattern) => pattern.test(command.trim()));
}

export function isLocalDependencyAssertion(command) {
  const assertions = command.trim().split(/\r?\n/).filter(Boolean);
  return (
    assertions.length > 0 &&
    assertions.every((assertion) =>
      /^test '\$\{\{ needs\.[a-zA-Z0-9_-]+\.result \}\}' = success$/.test(assertion.trim()),
    )
  );
}

const CODEMOD_IDEMPOTENCY_ASSERTION = "git diff --quiet -- . ':!packages/*/pkg/**'";

export function isLocalCodemodIdempotencyAssertion(command) {
  return (
    command.includes('bash scripts/codemod/rename-engine-family.sh') &&
    command.endsWith(CODEMOD_IDEMPOTENCY_ASSERTION)
  );
}

export function codemodCommandWithoutAssertion(command) {
  return command.slice(0, -CODEMOD_IDEMPOTENCY_ASSERTION.length).replace(/\n+$/, '');
}

export function codemodIdempotencyDiff(root = ROOT) {
  const result = spawnSync('git', ['diff', '--', '.', ':!packages/*/pkg/**'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('ci-local-verify-codemod-diff-failed');
  return result.stdout;
}

export function isLocalSharedProvenanceOutput(name, record) {
  const match = name.match(/^provenance-shared-app-inputs-a(\d+|NaN)\.json$/);
  if (!match || record?.schemaVersion !== 1 || record.producer !== 'shared-app-inputs') {
    return false;
  }
  const attempt = match[1];
  const artifactName = `shared-app-inputs-a${attempt}`;
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) return false;
  const namesMatch = record.artifacts.every((artifact) => artifact?.artifactName === artifactName);
  if (!namesMatch) return false;
  if (attempt === 'NaN') return record.runAttempt === null;
  const localArtifactIds = new Set([`local-${artifactName}`, SHARED_ARTIFACT_ID_EXPRESSION]);
  return (
    record.runId === 'local' &&
    record.runAttempt === Number(attempt) &&
    record.artifacts.every((artifact) => localArtifactIds.has(artifact.artifactId))
  );
}

export function isolateLocalProvenanceForLint(root = ROOT) {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-ci-provenance-'));
  const moved = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = resolve(root, entry.name);
      let record;
      try {
        record = JSON.parse(readFileSync(source, 'utf8'));
      } catch {
        continue;
      }
      if (!isLocalSharedProvenanceOutput(entry.name, record)) continue;
      const destination = resolve(directory, entry.name);
      renameSync(source, destination);
      moved.push({ source, destination });
    }
  } catch (error) {
    for (const { source, destination } of moved.reverse()) renameSync(destination, source);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return () => {
    for (const { source, destination } of moved.reverse()) renameSync(destination, source);
    rmSync(directory, { recursive: true, force: true });
  };
}

export function needsLocalProvenanceIsolation(command) {
  return command === 'pnpm run lint' || command === 'bunx biome ci .';
}

export function isRunnerProvisioning(command) {
  if (/\$\{?(?:RUNNER_TEMP)\}?\b|\bnproc\b|\/proc\/cpuinfo/.test(command)) return true;
  if (!/\$\{?GITHUB_PATH\}?\b/.test(command)) return false;
  return command
    .split(/\r?\n/)
    .every(
      (line) =>
        !line.trim() || line.trim().startsWith('#') || />>\s*['"]?\$\{?GITHUB_PATH/.test(line),
    );
}

export function localizeRunnerProvisioning(command) {
  return command
    .split(/\r?\n/)
    .filter((line) => !/>>\s*['"]?\$\{?GITHUB_PATH/.test(line))
    .join('\n')
    .trim();
}

/**
 * The browser job's Xvfb + headed wrapper is an Ubuntu runner contract. Native
 * macOS Chromium does not consume an X11 DISPLAY, so use its working headless
 * WebGPU path for the local projection instead.
 */
export function localizeDarwinXvfb(command, platform = process.platform) {
  if (platform !== 'darwin') return command;
  return command.replace(
    /^([ \t]*)xvfb-run -a env FORGEAX_BROWSER_HEADLESS=0 /gm,
    '$1env CI=1 FORGEAX_BROWSER_HEADLESS=1 ',
  );
}

export function requiredContexts() {
  const contexts = JSON.parse(readFileSync(REQUIRED, 'utf8'));
  if (!Array.isArray(contexts) || contexts.some((value) => typeof value !== 'string')) {
    throw new Error('ci-local-verify-required-contexts-invalid: expected a string array');
  }
  return contexts;
}

export function jobDependencies(workflow, job) {
  const match = jobBlock(workflow, job).match(
    /^ {4}needs:\s*(?:\[([^\]]*)\]|([a-zA-Z0-9_-]+))\s*$/m,
  );
  if (!match) return [];
  return (match[1] ?? match[2])
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

export function jobEnvironment(block) {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {4}env:\s*$/.test(line));
  if (start === -1) return {};
  const environment = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {6}([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (match) {
      environment[match[1]] = yamlScalar(match[2]);
      continue;
    }
    if (lines[index].trim() && !/^ {6}#/.test(lines[index])) break;
  }
  return environment;
}

export function jobOutputExpressions(block) {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {4}outputs:\s*$/.test(line));
  if (start === -1) return {};
  const outputs = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {6}([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) {
      outputs[match[1]] = yamlScalar(match[2]);
      continue;
    }
    if (lines[index].trim() && !/^ {6}#/.test(lines[index])) break;
  }
  return outputs;
}

function resolveJobOutputs(block, stepOutputs, runtime) {
  return Object.fromEntries(
    Object.entries(jobOutputExpressions(block)).map(([name, expression]) => [
      name,
      substituteLocalStepOutputs(expression, runtime, stepOutputs),
    ]),
  );
}

export function matrixCombinations(block) {
  const lines = block.split(/\r?\n/);
  const matrixStart = lines.findIndex((line) => /^ {6}matrix:\s*$/.test(line));
  if (matrixStart === -1) return [{}];
  const dimensions = [];
  for (let index = matrixStart + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {8}([a-zA-Z][a-zA-Z0-9_-]*):\s*\[([^\]]*)\]\s*$/);
    if (match) {
      dimensions.push({
        key: match[1],
        values: match[2]
          .split(',')
          .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
      });
      continue;
    }
    if (lines[index].trim() && !/^ {8}#/.test(lines[index])) break;
  }
  return dimensions.reduce(
    (combinations, dimension) =>
      combinations.flatMap((combination) =>
        dimension.values.map((value) => ({ ...combination, [dimension.key]: value })),
      ),
    [{}],
  );
}

export function isMatrixStepEnabled(condition, matrix) {
  if (!condition?.includes('matrix.')) return true;
  if (/\bfalse\b/.test(condition) || condition.includes('failure()')) return false;
  return [...condition.matchAll(/matrix\.([a-zA-Z0-9_-]+)\s*==\s*['"]?(\w+)['"]?/g)].every(
    ([, key, value]) => String(matrix[key]) === value,
  );
}

export function targetsForJobs(workflow, roots) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (job) => {
    if (visited.has(job)) return;
    if (visiting.has(job)) throw new Error(`ci-local-verify-needs-cycle: jobs.${job}`);
    visiting.add(job);
    for (const dependency of jobDependencies(workflow, job)) visit(dependency);
    visiting.delete(job);
    visited.add(job);
    ordered.push(job);
  };
  for (const job of roots) visit(job);
  return ordered;
}

export function localTargets(workflow) {
  return targetsForJobs(
    workflow,
    requiredContexts().map((context) => contextJob(context)),
  );
}

export function targetsForGroup(group, workflow) {
  const root = requiredContexts().includes(group) ? contextJob(group) : group;
  return targetsForJobs(workflow, [root]);
}

function matrixSelection(group, job) {
  if (!group || contextJob(group) !== job) return undefined;
  const prefix = `${job}-`;
  if (!group.startsWith(prefix)) return undefined;
  return { group: group.slice(prefix.length) };
}

function parseArgs(argv) {
  const group = argv.indexOf('--group');
  if (group !== -1 && !argv[group + 1])
    throw new Error('ci-local-verify-group-missing: --group needs a local CI target');
  return {
    list: argv.includes('--list'),
    dryRun: argv.includes('--dry-run'),
    group: group === -1 ? undefined : argv[group + 1],
  };
}

export function plansFor(job, workflow, selectedMatrix) {
  const block = jobBlock(workflow, job);
  const requires = [];
  if (/install-mesa-vulkan-drivers/.test(block)) requires.push('Mesa Vulkan / lavapipe');
  if (/install-playwright-(chrome-beta|browser)/.test(block))
    requires.push('Playwright browser binary');
  if (/actions\/download-artifact/.test(block))
    requires.push('CI build artifacts (replaced by this checkout)');
  const matrices = selectedMatrix ? [selectedMatrix] : matrixCombinations(block);
  return matrices.map((matrix) => ({
    job,
    matrix,
    steps: extractRunSteps(block).filter((step) => isMatrixStepEnabled(step.condition, matrix)),
    environment: jobEnvironment(block),
    requires,
  }));
}

function run(
  step,
  dryRun,
  environment,
  matrix,
  needsResults,
  needsOutputs,
  githubEnvironment,
  stepOutputs,
  codemodBaseline,
) {
  const runtime = localGitHubRuntime(process.env);
  const command = substituteLocalMatrix(
    substituteLocalNeedsOutputs(
      substituteLocalStepOutputs(
        step.command.replaceAll(GITHUB_RUN_ATTEMPT, runtime.GITHUB_RUN_ATTEMPT),
        runtime,
        stepOutputs,
      ),
      runtime.GITHUB_RUN_ATTEMPT,
      needsOutputs,
    ),
    matrix,
  );
  const isCodemodAssertion = isLocalCodemodIdempotencyAssertion(command);
  const runnerLocalized = localizeRunnerProvisioning(
    isCodemodAssertion ? codemodCommandWithoutAssertion(command) : command,
  );
  const platformLocalized = localizeDarwinXvfb(runnerLocalized);
  const localStep = {
    ...step,
    command: platformLocalized,
  };
  if (platformLocalized !== runnerLocalized) {
    console.log(
      '[ci] macOS local adaptation: replaced Linux Xvfb headed browser with Chromium headless',
    );
  }
  console.log(`\n[ci:${dryRun ? 'dry-run' : 'run'}] ${command}`);
  if (dryRun) return 0;
  const temporaryFiles =
    needsStepSummary(localStep.command) ||
    needsGitHubOutput(localStep.command) ||
    needsGitHubEnvironment(localStep.command);
  const githubFilesDir = temporaryFiles
    ? mkdtempSync(resolve(tmpdir(), 'forgeax-ci-summary-'))
    : undefined;
  try {
    const githubFiles = githubFilesDir
      ? localGitHubFilePaths(localStep.command, githubFilesDir)
      : {};
    for (const path of Object.values(githubFiles)) {
      writeFileSync(path, '');
    }
    const env = {
      ...runtime,
      ...process.env,
      ...githubEnvironment,
      ...Object.fromEntries(
        Object.entries({ ...environment, ...step.environment }).map(([name, value]) => [
          name,
          substituteLocalMatrix(
            substituteLocalNeedsOutputs(
              substituteLocalNeedsResults(
                substituteLocalStepOutputs(value, runtime, stepOutputs),
                needsResults,
              ),
              runtime.GITHUB_RUN_ATTEMPT,
              needsOutputs,
            ),
            matrix,
          ),
        ]),
      ),
      ...githubFiles,
    };
    const restoreLocalProvenance = needsLocalProvenanceIsolation(localStep.command)
      ? isolateLocalProvenanceForLint()
      : undefined;
    const plan = executionPlan(localStep);
    let result;
    try {
      result = spawnSync(plan.executable, plan.args, {
        cwd: ROOT,
        stdio: 'inherit',
        env,
      });
    } finally {
      restoreLocalProvenance?.();
    }
    if (step.id !== undefined && githubFiles.GITHUB_OUTPUT) {
      stepOutputs.set(step.id, {
        ...(stepOutputs.get(step.id) ?? {}),
        ...readLocalGitHubEnvironment(readFileSync(githubFiles.GITHUB_OUTPUT, 'utf8')),
      });
    }
    if (githubFiles.GITHUB_ENV) {
      Object.assign(
        githubEnvironment,
        readLocalGitHubEnvironment(readFileSync(githubFiles.GITHUB_ENV, 'utf8')),
      );
    }
    if (result.status !== 0) return result.status ?? 1;
    if (isCodemodAssertion && codemodIdempotencyDiff() !== codemodBaseline) {
      console.error('[ci] codemod idempotency created tracked changes beyond the initial baseline');
      return 1;
    }
    return 0;
  } finally {
    if (githubFilesDir) rmSync(githubFilesDir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const all = localTargets(workflow);
  if (args.group && !all.includes(args.group) && !requiredContexts().includes(args.group)) {
    throw new Error(`ci-local-verify-group-unknown: ${args.group} is not a local CI target`);
  }
  const targets = args.group ? targetsForGroup(args.group, workflow) : all;
  const codemodBaseline = args.list || args.dryRun ? undefined : codemodIdempotencyDiff();
  const needsResults = new Map();
  const needsOutputs = new Map();
  const githubEnvironment = {};
  for (const target of targets) {
    const selectedMatrix = matrixSelection(args.group, target);
    const plans = plansFor(target, workflow, selectedMatrix);
    const stepOutputs = new Map();
    for (const plan of plans) {
      const matrixLabel = Object.values(plan.matrix).join(',');
      console.log(`\n[ci] jobs.${plan.job}${matrixLabel ? `-${matrixLabel}` : ''}`);
      if (plan.requires.length) console.log(`[ci] prerequisites: ${plan.requires.join('; ')}`);
      for (const step of plan.steps) {
        const { command } = step;
        if (isLocalSharedProvenanceDownload(command)) {
          if (!args.dryRun) {
            provideLocalSharedProvenance(localGitHubRuntime(process.env).GITHUB_RUN_ATTEMPT);
          }
          console.log(`[ci] local artifact substitute: ${command}`);
          continue;
        }
        if (isLocalShardReportsDownload(command)) {
          if (!args.dryRun) provideLocalShardReports();
          console.log(`[ci] local artifact substitute: ${command}`);
          continue;
        }
        if (isSetupOnly(command)) {
          console.log(`[ci] source-checkout substitute: ${command}`);
          continue;
        }
        if (isLocalDependencyAssertion(command)) {
          console.log(`[ci] local dependency ordering satisfies: ${command}`);
          continue;
        }
        if (isRunnerProvisioning(command)) {
          console.log(`[ci] runner provisioning omitted (use local toolchain): ${command}`);
          continue;
        }
        if (args.list) {
          const listedCommand = localizeDarwinXvfb(substituteLocalMatrix(command, plan.matrix));
          console.log(`[ci] (${step.shell ?? 'default'}) ${listedCommand}`);
          continue;
        }
        const status = run(
          step,
          args.dryRun,
          plan.environment,
          plan.matrix,
          needsResults,
          needsOutputs,
          githubEnvironment,
          stepOutputs,
          codemodBaseline,
        );
        if (status !== 0) {
          needsResults.set(target, 'failure');
          console.error(`[ci] FAIL ${plan.job}: first failing step exited ${status}`);
          return status;
        }
      }
    }
    needsResults.set(target, 'success');
    needsOutputs.set(
      target,
      resolveJobOutputs(jobBlock(workflow, target), stepOutputs, localGitHubRuntime(process.env)),
    );
  }
  console.log(
    `\n[ci] PASS: ${targets.length} PR CI job${targets.length === 1 ? '' : 's'} projected from ci.yml`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[ci] ${error.message}`);
    process.exitCode = 2;
  }
}
