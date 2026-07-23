#!/usr/bin/env node
// Local projection of the required PR CI surface. The workflow remains the
// command SSOT: this runner extracts its shell steps instead of copying them.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/** Extract shell bodies from the narrow YAML forms used by this workflow. */
export function extractRunCommands(block) {
  const lines = block.split(/\r?\n/);
  const commands = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {8}run: (.*)$/);
    if (!match) continue;
    const value = match[1];
    if (value !== '|' && value !== '>-') {
      commands.push(value.trim());
      continue;
    }
    const body = [];
    for (i += 1; i < lines.length && /^ {10}/.test(lines[i]); i += 1) {
      body.push(lines[i].slice(10));
    }
    i -= 1;
    commands.push(value === '|' ? body.join('\n').trim() : body.join(' ').trim());
  }
  return commands.filter(Boolean);
}

export function contextJob(context) {
  return MATRIX_CONTEXTS.get(context) ?? context;
}

export function isSetupOnly(command) {
  return SETUP_ONLY.some((pattern) => pattern.test(command.trim()));
}

export function isRunnerProvisioning(command) {
  return /\$(?:RUNNER_TEMP|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_ENV)\b|\bnproc\b|\/proc\/cpuinfo/.test(
    command,
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
  return { job, commands: extractRunCommands(block), requires };
}

function run(command, dryRun) {
  const localCommand = command.replaceAll(GITHUB_RUN_ATTEMPT, '1');
  console.log(`\n[ci:${dryRun ? 'dry-run' : 'run'}] ${localCommand}`);
  if (dryRun) return 0;
  const result = spawnSync(localCommand, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
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
    console.log(`\n[ci] jobs.${plan.job}`);
    if (plan.requires.length) console.log(`[ci] prerequisites: ${plan.requires.join('; ')}`);
    for (const command of plan.commands) {
      if (isSetupOnly(command)) {
        console.log(`[ci] source-checkout substitute: ${command}`);
        continue;
      }
      if (isRunnerProvisioning(command)) {
        console.log(`[ci] runner provisioning omitted (use local toolchain): ${command}`);
        continue;
      }
      if (args.list) {
        console.log(`[ci] ${command}`);
        continue;
      }
      const status = run(command, args.dryRun);
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
