#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '__tests__' ||
      entry.name === 'test' ||
      entry.name === 'tests'
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(path));
    else if (
      entry.isFile() &&
      /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(entry.name)
    )
      result.push(path);
  }
  return result;
}

function projects() {
  const packagesRoot = resolve(root, 'packages');
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name))
    .filter((directory) => existsSync(resolve(directory, 'tsconfig.json')))
    .map((directory) => ({
      directory,
      tsconfig: resolve(directory, 'tsconfig.json'),
      config: JSON.parse(readFileSync(resolve(directory, 'tsconfig.json'), 'utf8')),
    }))
    .filter(
      ({ config }) =>
        config.compilerOptions?.declaration === true && config.compilerOptions?.noEmit !== true,
    );
}

const missing = [];
for (const project of projects()) {
  const options = project.config.compilerOptions ?? {};
  const sourceRoot = resolve(project.directory, options.rootDir ?? 'src');
  const outputRoot = resolve(project.directory, options.declarationDir ?? options.outDir ?? 'dist');
  for (const source of sourceFiles(sourceRoot)) {
    const output = resolve(
      outputRoot,
      relative(sourceRoot, source).replace(/\.(?:tsx|mts|cts|ts)$/, '.d.ts'),
    );
    if (!existsSync(output)) {
      missing.push({ project: project.tsconfig, output });
      break;
    }
  }
}

if (missing.length === 0) {
  console.error('[types-preflight] declaration inventory complete');
  process.exit(0);
}

console.error(
  `[types-preflight] ${missing.length} project(s) have missing declarations; forcing project rebuild`,
);
for (const item of missing)
  console.error(`[types-preflight] missing ${relative(root, item.output)}`);

const args =
  missing.length > 3
    ? ['exec', 'tsc', '-b', '--force']
    : ['exec', 'tsc', '-b', ...missing.map((item) => relative(root, item.project)), '--force'];
const result = spawnSync('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});
process.exit(result.status ?? 1);
