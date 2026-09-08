#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRetryableOutput, runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const defaultShardCount = 1;
const defaultShardIndex = 0;
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const advancedLightingBrowserFiles = new Set([
  'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
]);
const bloomBrowserFile =
  'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts';
const browserProcessIsolatedFiles = new Set([
  ...advancedLightingBrowserFiles,
  'packages/app/__tests__/thin-wrapper.browser.test.ts',
  'packages/app/__tests__/worker-resize.browser.test.ts',
  'packages/runtime/src/__tests__/render-feature-prepared-graphics.browser.test.ts',
]);
const excludedDirectories = new Set(['.git', 'artifacts', 'dist', 'node_modules']);

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const valueOptions = new Set(['--group-size', '--max-workers', '--shard-count', '--shard-index']);
  const options = {
    dryRun: false,
    groupSize: defaultGroupSize,
    maxWorkers: defaultMaxWorkers,
    shardCount: defaultShardCount,
    shardIndex: defaultShardIndex,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 12 });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', { max: 32 });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 31)
        throw new Error(`--shard-index must be an integer from 0 to 31, got ${value}`);
      options.shardIndex = parsed;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.shardIndex >= options.shardCount)
    throw new Error(
      `--shard-index must be less than --shard-count, got ${options.shardIndex + 1}/${options.shardCount}`,
    );
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

function planGroups(files, groupSize) {
  const preview = files.filter((file) => file.startsWith('apps/preview/'));
  const isolated = files.filter((file) => browserProcessIsolatedFiles.has(file));
  const regular = files.filter(
    (file) => !file.startsWith('apps/preview/') && !browserProcessIsolatedFiles.has(file),
  );

  // These owners create a real WebGPU device or a multi-pass pipeline whose
  // cold start has exceeded the ordinary Vitest budget on persistent runners.
  // Vitest's historical-duration scheduler can otherwise make their
  // app/renderer lifecycles contend with neighboring files. Keep the stable
  // advanced-lighting owners in one fresh process so Vite's dependency
  // optimizer and the WebGPU device are paid for once, but give Bloom its own
  // process: its multi-pass bootstrap has a materially different cold path and
  // previously consumed the shared 60s test budget before the app became
  // observable. The test files retain their own bounded budgets and real
  // WebGPU assertions, while ordinary browser files keep four-per-group
  // throughput.
  const sharedAdvancedLighting = isolated.filter(
    (file) => advancedLightingBrowserFiles.has(file) && file !== bloomBrowserFile,
  );
  const isolatedGroups = [
    ...(sharedAdvancedLighting.length > 0 ? [sharedAdvancedLighting] : []),
    ...(isolated.includes(bloomBrowserFile) ? [[bloomBrowserFile]] : []),
    ...isolated.filter((file) => !advancedLightingBrowserFiles.has(file)).map((file) => [file]),
  ];
  return [
    ...(preview.length > 0 ? [preview] : []),
    ...isolatedGroups,
    ...chunk(regular, groupSize),
  ];
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

async function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  const previewGroup = group.some((file) => file.startsWith('apps/preview/'));
  const isolatedColdOwner = group.length === 1 && browserProcessIsolatedFiles.has(group[0]);
  // Isolated cold owners already have a fresh Vitest process and should not
  // pay the full Pack producer scan before importing their one SUT. Their
  // asset GUIDs are still validated by the same runtime import transport;
  // `on-demand` only moves the producer work behind the first real request.
  // Preview remains before-consume because its contract asserts a complete
  // template catalog before the consumer starts.
  const producerReadiness = previewGroup
    ? 'before-consume'
    : isolatedColdOwner || process.env.FORGEAX_BROWSER_PACK_READINESS === 'on-demand'
      ? 'on-demand'
      : 'before-consume';
  const command = [
    process.execPath,
    cliPath,
    'run',
    '--config',
    'vitest.browser.config.ts',
    '--project=browser',
    `--maxWorkers=${maxWorkers}`,
    ...group,
  ];
  const environment = {
    ...process.env,
    FORGEAX_BROWSER_ENTITY_VISIBILITY: '0',
    FORGEAX_BROWSER_PACK_READINESS: producerReadiness,
    FORGEAX_TOOL_PREVIEW: '1',
  };
  const first = await runBrowserCommand(command, { cwd: rootDir, env: environment });
  if (first.status === 0) return;
  if (!isRetryableOutput('vitest', first.output)) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed with status ${first.status}; files=${group.join(', ')}`,
    );
  }

  process.stderr.write(
    `::warning::Vitest browser group ${groupIndex}/${groupCount} reported declared runner instability; retrying only this group once with a fresh process\n`,
  );
  const second = await runBrowserCommand(command, { cwd: rootDir, env: environment });
  if (second.status !== 0) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed after one isolated retry with status ${second.status}; files=${group.join(', ')}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = browserTestFiles();
  const groups = planGroups(files, options.groupSize);
  if (groups.length === 0) throw new Error('no browser test files were discovered');
  const selectedGroups = groups.filter(
    (_group, groupIndex) => groupIndex % options.shardCount === options.shardIndex,
  );
  if (selectedGroups.length === 0)
    throw new Error(
      `browser shard ${options.shardIndex + 1}/${options.shardCount} selected no groups from ${groups.length}`,
    );

  if (options.dryRun) {
    for (const [index, group] of groups.entries()) {
      if (index % options.shardCount !== options.shardIndex) continue;
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')} (${group.length} files): ${group.join(', ')}\n`,
      );
    }
    return;
  }

  const cliPath = resolveCliPath();
  for (const [index, group] of groups.entries()) {
    if (index % options.shardCount !== options.shardIndex) continue;
    await runGroup({
      cliPath,
      group,
      groupIndex: index + 1,
      groupCount: groups.length,
      maxWorkers: options.maxWorkers,
    });
  }
  process.stdout.write(
    `[vitest] split browser passed: groups=${groups.length}, selected=${selectedGroups.length}, files=${files.length}, shard=${options.shardIndex + 1}/${options.shardCount}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[vitest] split browser failed: ${error.message}\n`);
  process.exitCode = 1;
}
