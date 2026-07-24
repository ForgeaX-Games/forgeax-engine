#!/usr/bin/env node
// Local projection of the required PR CI surface. The workflow remains the
// command SSOT: this runner extracts its shell steps instead of copying them.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Extract run steps, preserving explicit workflow shells. */
export function extractRunSteps(block) {
  const lines = block.split(/\r?\n/);
  const steps = [];
  let shell;
  let stepEnv = {};
  for (let i = 0; i < lines.length; i += 1) {
    const shellMatch = lines[i].match(/^ {8}shell: (.*)$/);
    if (shellMatch) {
      shell = shellMatch[1].trim();
      continue;
    }
    if (/^ {8}env:\s*$/.test(lines[i])) {
      for (i += 1; i < lines.length && /^ {10}/.test(lines[i]); i += 1) {
        const envMatch = lines[i].match(/^ {10}([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/);
        if (envMatch) stepEnv[envMatch[1]] = envMatch[2].trim();
      }
      i -= 1;
      continue;
    }
    const match = lines[i].match(/^ {8}run: (.*)$/);
    if (!match) continue;
    const value = match[1];
    if (value !== '|' && value !== '>-') {
      steps.push({ command: value.trim(), shell, env: stepEnv });
      shell = undefined;
      stepEnv = {};
      continue;
    }
    const body = [];
    for (i += 1; i < lines.length && /^ {10}/.test(lines[i]); i += 1) {
      body.push(lines[i].slice(10));
    }
    i -= 1;
    steps.push({
      command: value === '|' ? body.join('\n').trim() : body.join(' ').trim(),
      shell,
      env: stepEnv,
    });
    shell = undefined;
    stepEnv = {};
  }
  return steps.filter(({ command }) => Boolean(command));
}

/** Extract shell bodies from the narrow YAML forms used by this workflow. */
export function extractRunCommands(block) {
  return extractRunSteps(block).map(({ command }) => command);
}

/** Extract job-level environment values from the narrow YAML forms used here. */
export function extractJobEnv(block) {
  const lines = block.split(/\r?\n/);
  const env = {};
  const start = lines.findIndex((line) => /^ {4}env:\s*$/.test(line));
  if (start === -1) return env;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {6}([A-Z][A-Z0-9_]*)\s*:\s*(.*)$/);
    if (match) {
      env[match[1]] = match[2].trim();
      continue;
    }
    if (lines[index].trim() !== '' && !/^ {6}/.test(lines[index])) break;
  }
  return env;
}

export function contextJob(context) {
  return MATRIX_CONTEXTS.get(context) ?? context;
}

export function isSetupOnly(command) {
  return SETUP_ONLY.some((pattern) => pattern.test(command.trim()));
}

export function isRunnerProvisioning(command) {
  if (/nohup pnpm dev/.test(command)) return false;
  if (/node scripts\/ci\/(?:build-shared-app-inputs|merge-provenance-records)\.mjs\b/.test(command))
    return false;
  return /\$(?:RUNNER_TEMP|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_ENV)\b|\bnproc\b|\/proc\/cpuinfo/.test(
    command,
  );
}

/** Mirror the workflow's paths-filter guard for the codemod idempotency step. */
export function isPathFiltered(command) {
  if (!/rename-engine-family\.sh/.test(command)) return false;
  return (
    spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'scripts/codemod'], {
      cwd: ROOT,
      stdio: 'ignore',
    }).status === 0
  );
}

export function isHostLimitedJob(job) {
  return process.platform === 'darwin' && job === 'webkit-fallback';
}

/** Project the workflow expressions that have a deterministic local equivalent. */
export function projectGithubExpressions(command) {
  return command
    .replace(/\$\{\{\s*matrix\.group\s*\}\}/g, '0')
    .replace(/\$\{\{\s*github\.run_attempt\s*\}\}/g, '1')
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, 'local-verify')
    .replace(/\$\{\{\s*needs\.([a-zA-Z0-9_-]+)\.result\s*\}\}/g, 'success')
    .replace(
      /\$\{\{\s*needs\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_-]+)\s*\}\}/g,
      (_, job, output) => `local-${job}-${output}`,
    )
    .replace(/\$\{\{\s*github\.[^}]+\s*\}\}/g, 'local-verify');
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

function planFor(job, workflow) {
  const block = jobBlock(workflow, job);
  const requires = [];
  if (/install-mesa-vulkan-drivers/.test(block)) requires.push('Mesa Vulkan / lavapipe');
  if (/install-playwright-(chrome-beta|browser)/.test(block))
    requires.push('Playwright browser binary');
  if (/actions\/download-artifact/.test(block))
    requires.push('CI build artifacts (replaced by this checkout)');
  return { job, env: extractJobEnv(block), steps: extractRunSteps(block), requires };
}

function run(command, dryRun, shell, jobEnv, job) {
  const localCommand = projectLocalCommand(
    projectGithubExpressions(command.replaceAll(GITHUB_RUN_ATTEMPT, '1')),
    job,
  );
  console.log(`\n[ci:${dryRun ? 'dry-run' : 'run'}] ${localCommand}`);
  if (dryRun) return 0;
  const env = {
    ...process.env,
    ...jobEnv,
    GITHUB_OUTPUT: process.env.GITHUB_OUTPUT ?? '/tmp/forgeax-local-verify-output',
    GITHUB_ENV: process.env.GITHUB_ENV ?? '/tmp/forgeax-local-verify-env',
    GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY ?? '/tmp/forgeax-local-verify-summary',
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID ?? 'local-verify',
    SHARED_ARTIFACT_ID: process.env.SHARED_ARTIFACT_ID ?? 'local-shared-app-inputs-id',
  };
  const result =
    shell === 'node {0}'
      ? spawnSync(process.execPath, ['-e', localCommand], {
          cwd: ROOT,
          stdio: 'inherit',
          env,
        })
      : shell === 'bash'
        ? spawnSync('bash', ['-c', localCommand], {
            cwd: ROOT,
            stdio: 'inherit',
            env,
          })
        : spawnSync(localCommand, {
            cwd: ROOT,
            shell: true,
            stdio: 'inherit',
            env,
          });
  return result.status ?? 1;
}

function projectLocalCommand(command, job) {
  if (!/^app-shard-[0-9]+$/.test(job ?? '')) return command;
  const artifactRoot = `ci-artifacts/${job}`;
  return command
    .replaceAll('shard-output', `${artifactRoot}/shard-output`)
    .replaceAll('shard-transfer', `${artifactRoot}/shard-transfer`);
}

function prepareLocalBuildArtifacts(job) {
  if (job !== 'build-artifacts') return;
  const reports = resolve(ROOT, 'shard-reports/report');
  rmSync(resolve(ROOT, 'shard-reports'), { recursive: true, force: true });
  mkdirSync(reports, { recursive: true });
  for (const shard of ['app-shard-0', 'app-shard-1', 'app-shard-2']) {
    const source = resolve(ROOT, `ci-artifacts/${shard}/shard-transfer/report`);
    if (existsSync(source)) cpSync(source, reports, { recursive: true });
  }
  const sharedProvenance = resolve(ROOT, 'provenance-shared-app-inputs-a1.json');
  if (existsSync(sharedProvenance)) {
    const record = JSON.parse(readFileSync(sharedProvenance, 'utf8'));
    writeFileSync(sharedProvenance, `${JSON.stringify(record, null, 2)}\n`);
    mkdirSync(resolve(ROOT, 'provenance-records'), { recursive: true });
    cpSync(
      sharedProvenance,
      resolve(ROOT, 'provenance-records/provenance-shared-app-inputs-a1.json'),
    );
  }
}

function releaseLocalDevPorts() {
  for (const port of ['5173', '5174']) {
    const result = spawnSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    for (const pid of (result.stdout ?? '').trim().split(/\s+/).filter(Boolean)) {
      const command =
        spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
      const cwd =
        spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
          encoding: 'utf8',
        }).stdout ?? '';
      if (cwd.includes(ROOT) && /(node|vite|bun)/.test(command)) process.kill(Number(pid));
    }
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
  const plans = targets.map((target) => planFor(target, workflow));
  for (const plan of plans) {
    if (isHostLimitedJob(plan.job)) {
      console.log(`[ci] host-limited job omitted on ${process.platform}: ${plan.job}`);
      continue;
    }
    prepareLocalBuildArtifacts(plan.job);
    console.log(`\n[ci] jobs.${plan.job}`);
    if (plan.requires.length) console.log(`[ci] prerequisites: ${plan.requires.join('; ')}`);
    for (const step of plan.steps) {
      const { command, shell, env: stepEnv } = step;
      if (isSetupOnly(command)) {
        console.log(`[ci] source-checkout substitute: ${command}`);
        continue;
      }
      if (isRunnerProvisioning(command)) {
        console.log(`[ci] runner provisioning omitted (use local toolchain): ${command}`);
        continue;
      }
      if (isPathFiltered(command)) {
        console.log(`[ci] workflow path filter omitted: ${command}`);
        continue;
      }
      if (args.list) {
        console.log(`[ci] ${command}`);
        continue;
      }
      const projectedStepEnv = Object.fromEntries(
        Object.entries(stepEnv).map(([key, value]) => [key, projectGithubExpressions(value)]),
      );
      if (plan.job === 'portability-bun' && command.includes('localhost:5173')) {
        releaseLocalDevPorts();
      }
      const status = run(
        command,
        args.dryRun,
        shell,
        { ...plan.env, ...projectedStepEnv },
        plan.job,
      );
      if (status !== 0) {
        console.error(`[ci] FAIL ${plan.job}: first failing step exited ${status}`);
        return status;
      }
    }
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
