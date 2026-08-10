#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const excludedDirectories = new Set(['.git', 'dist', 'node_modules']);

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    groupSize: defaultGroupSize,
    maxWorkers: defaultMaxWorkers,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 12 });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function browserTestFiles(directory = rootDir, relativeDirectory = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (
        excludedDirectories.has(entry.name) ||
        relativePath === '.worktrees' ||
        relativePath === path.join('.claude', 'worktrees') ||
        relativePath.startsWith(`${path.join('.claude', 'worktrees')}${path.sep}`)
      ) {
        continue;
      }
      files.push(...browserTestFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.browser.test.ts') &&
      relativePath !== entityVisibilityBrowserTest
    ) {
      files.push(relativePath.split(path.sep).join('/'));
    }
  }
  return files;
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function resolveCliPath() {
  const candidates = [
    path.join(rootDir, 'node_modules/vitest/vitest.mjs'),
    path.join(rootDir, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  const child = spawnSync(
    process.execPath,
    [
      cliPath,
      'run',
      '--config',
      'vitest.browser.config.ts',
      '--project=browser',
      `--maxWorkers=${maxWorkers}`,
      ...group,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, FORGEAX_BROWSER_ENTITY_VISIBILITY: '0' },
      stdio: 'inherit',
    },
  );
  if (child.error) {
    throw new Error(`Vitest browser group ${groupIndex} could not start: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed with status ${child.status}; files=${group.join(', ')}`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = browserTestFiles();
  const groups = chunk(files, options.groupSize);
  if (groups.length === 0) throw new Error('no browser test files were discovered');

  if (options.dryRun) {
    for (const [index, group] of groups.entries()) {
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')} (${group.length} files): ${group.join(', ')}\n`,
      );
    }
    return;
  }

  const cliPath = resolveCliPath();
  for (const [index, group] of groups.entries()) {
    runGroup({
      cliPath,
      group,
      groupIndex: index + 1,
      groupCount: groups.length,
      maxWorkers: options.maxWorkers,
    });
  }
  process.stdout.write(
    `[vitest] split browser passed: groups=${groups.length}, files=${files.length}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`[vitest] split browser failed: ${error.message}\n`);
  process.exitCode = 1;
}
