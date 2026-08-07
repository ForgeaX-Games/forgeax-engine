#!/usr/bin/env node
// Enforce explicit resource-pool labels on every self-hosted workflow job.
// GitHub-hosted labels remain valid for cross-platform jobs such as nightly.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SELF_HOSTED_LABEL = 'self-hosted';
export const POOL_LABELS = Object.freeze(['standard', 'heavy']);

const HOSTED_LABEL_PATTERN = /^(?:ubuntu|windows|macos)(?:-[a-z0-9][a-z0-9.-]*)?$/;

function withoutComment(line) {
  return line.replace(/\s+#.*$/, '').trimEnd();
}

function unquote(value) {
  let result = value.trim();
  let changed = true;
  while (changed && result.length >= 2) {
    changed = false;
    const first = result[0];
    const last = result.at(-1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      result = result.slice(1, -1).trim();
      changed = true;
    }
  }
  return result;
}

function parseArray(value) {
  const body = value.trim().slice(1, -1);
  if (!body.trim()) return [];
  return body
    .split(',')
    .map((entry) => unquote(entry))
    .filter(Boolean);
}

function parseStaticRunnerLabels(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseArray(trimmed);
  }

  const jsonExpression = trimmed.match(/fromJSON\(\s*(['"])(\[[\s\S]*\])\1\s*\)/);
  if (jsonExpression) {
    try {
      const parsed = JSON.parse(jsonExpression[2]);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  if (/^['"].*['"]$/.test(trimmed)) return [unquote(trimmed)];
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return [trimmed];
  return null;
}

function parseRunnerValue(value) {
  const unquoted = unquote(value);
  try {
    const parsed = JSON.parse(unquoted);
    if (typeof parsed === 'string') return [parsed];
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // The normal nightly form is a quoted scalar, not JSON after unquoting.
  }
  return unquoted ? [unquoted] : [];
}

function hostedLabel(label) {
  return HOSTED_LABEL_PATTERN.test(label);
}

function selectorError(file, line, job, message) {
  return `${file}:${line}: job ${job}: ${message}`;
}

export function classifyRunnerSelector(value, runnerValues = []) {
  const trimmed = value.trim();

  if (/fromJSON\(\s*matrix\.runner\s*\)/.test(trimmed)) {
    const labels = runnerValues.flatMap(parseRunnerValue);
    if (labels.length === 0) {
      return { kind: 'error', message: 'dynamic matrix.runner has no statically declared values' };
    }
    if (labels.includes(SELF_HOSTED_LABEL)) {
      return {
        kind: 'error',
        message: 'dynamic self-hosted runner selection must declare standard or heavy explicitly',
      };
    }
    return labels.every(hostedLabel)
      ? { kind: 'github-hosted', labels }
      : { kind: 'error', message: `unsupported dynamic runner labels: ${labels.join(', ')}` };
  }

  const labels = parseStaticRunnerLabels(trimmed);
  if (!labels) return { kind: 'error', message: `cannot statically classify runs-on: ${trimmed}` };

  if (labels.includes(SELF_HOSTED_LABEL)) {
    const pools = labels.filter((label) => POOL_LABELS.includes(label));
    if (pools.length !== 1) {
      return {
        kind: 'error',
        message: `self-hosted selector must contain exactly one of ${POOL_LABELS.join(' or ')}; found ${pools.length ? pools.join(', ') : 'neither'}`,
      };
    }
    return { kind: 'self-hosted', labels, pool: pools[0] };
  }

  return labels.length === 1 && labels.every(hostedLabel)
    ? { kind: 'github-hosted', labels }
    : { kind: 'error', message: `unsupported runner labels: ${labels.join(', ') || '<empty>'}` };
}

export function checkWorkflowText(text, file = '<workflow>') {
  const lines = text.split(/\r?\n/);
  const runnerValues = [];
  let inJobs = false;
  let currentJob = '<unknown>';
  const jobs = new Map();
  const selectors = [];
  const errors = [];

  for (const line of lines) {
    const clean = withoutComment(line);
    const runnerMatch = clean.match(/^\s*(?:-\s+)?runner:\s*(.+)$/);
    if (runnerMatch) runnerValues.push(runnerMatch[1]);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const clean = withoutComment(lines[index]);
    if (/^jobs:\s*$/.test(clean)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const jobMatch = clean.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, { hasRunsOn: false, hasUses: false });
      continue;
    }

    if (/^ {4}uses:\s*\S+/.test(clean) && jobs.has(currentJob)) {
      jobs.get(currentJob).hasUses = true;
    }

    const runsOnMatch = clean.match(/^ {4}runs-on:\s*(.*)$/);
    if (!runsOnMatch) continue;

    const value = runsOnMatch[1].trim();
    if (!value) {
      errors.push(
        selectorError(file, lineNumber, currentJob, 'runs-on must be a single-line selector'),
      );
      continue;
    }

    jobs.get(currentJob).hasRunsOn = true;
    const classification = classifyRunnerSelector(value, runnerValues);
    selectors.push({ file, line: lineNumber, job: currentJob, value, ...classification });
    if (classification.kind === 'error') {
      errors.push(selectorError(file, lineNumber, currentJob, classification.message));
    }
  }

  for (const [job, definition] of jobs) {
    if (!definition.hasRunsOn && !definition.hasUses) {
      errors.push(`${file}: job ${job}: job must declare runs-on or use a reusable workflow`);
    }
  }

  return { selectors, errors };
}

export function checkWorkflowDirectory(workflowsDir) {
  const directory = resolve(workflowsDir);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  const results = files.map((file) =>
    checkWorkflowText(readFileSync(`${directory}/${file}`, 'utf8'), file),
  );
  return {
    files,
    selectors: results.flatMap((result) => result.selectors),
    errors: results.flatMap((result) => result.errors),
  };
}

function argumentValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main() {
  const workflowsDir = argumentValue(process.argv.slice(2), '--workflows-dir', '.github/workflows');
  const result = checkWorkflowDirectory(workflowsDir);
  if (result.errors.length > 0) {
    process.stderr.write(
      `[reason] runner-pool-label-contract: every self-hosted job must declare exactly one of standard or heavy;\n         ${result.errors.join('\n         ')}\n[rerun]  node scripts/ci/check-runner-pool-labels.mjs --workflows-dir ${workflowsDir}\n[hint]   GitHub-hosted ubuntu/windows/macos selectors are allowed; self-hosted selectors are not.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const selfHosted = result.selectors.filter((selector) => selector.kind === 'self-hosted');
  const hosted = result.selectors.filter((selector) => selector.kind === 'github-hosted');
  process.stdout.write(
    `[ok] runner pool labels: ${selfHosted.length} self-hosted job selectors (${selfHosted.filter((selector) => selector.pool === 'standard').length} standard, ${selfHosted.filter((selector) => selector.pool === 'heavy').length} heavy); ${hosted.length} GitHub-hosted selector(s)\n`,
  );
}

const invoked =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
