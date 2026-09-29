#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSmokeFrameBudget } from '../ci/run-dawn-smoke-roster.mjs';

export function discoverSmokeApps(repoRoot) {
  const roots = [join(repoRoot, 'apps', 'hello'), join(repoRoot, 'apps', 'learn-render')];
  const results = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
      const candidate = join(directory, name);
      const packagePath = join(candidate, 'package.json');
      if (existsSync(packagePath)) {
        const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (
          typeof manifest.forgeax?.smokeInvocation === 'string' &&
          manifest.forgeax.smokeInvocation.trim().length > 0 &&
          typeof manifest.scripts?.smoke === 'string'
        ) {
          results.push({
            directory: candidate,
            name: manifest.name,
            invocation: manifest.forgeax.smokeInvocation,
          });
        }
      }
      if (isDirectory(candidate)) visit(candidate);
    }
  };
  for (const root of roots) visit(root);
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

function isDirectory(path) {
  return statSync(path).isDirectory();
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  let frames = parseSmokeFrameBudget(process.env.SMOKE_MIN_FRAMES);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--list') continue;
    if (args[index] !== '--frames' || args[index + 1] === undefined)
      throw new Error('usage: run-engine-smoke-roster.mjs [--list] [--frames INTEGER>=60]');
    frames = parseSmokeFrameBudget(args[++index]);
  }
  const roster = discoverSmokeApps(repoRoot);
  if (process.argv.includes('--list')) {
    console.log(JSON.stringify({ status: 'pass', apps: roster }, null, 2));
    process.exit(0);
  }
  const failures = [];
  for (const app of roster) {
    const result = spawnSync('pnpm', ['--dir', app.directory, 'run', 'smoke'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, SMOKE_MIN_FRAMES: String(frames) },
    });
    if (result.status !== 0) failures.push(app.name);
  }
  if (failures.length > 0) process.exitCode = 1;
  console.log(
    JSON.stringify({
      status: failures.length === 0 ? 'pass' : 'fail',
      count: roster.length,
      framesExpected: frames,
      failures,
    }),
  );
}
