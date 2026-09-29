#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareWgpuCheckout(root = process.cwd()) {
  const path = 'third_party/wgpu';
  const env = { ...process.env };
  const run = (args) => spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  const checked = (args) => {
    const result = run(args);
    if (result.status !== 0)
      throw new Error(
        `[wgpu-checkout] ${args[0]} failed: ${result.stderr || result.error?.message}`,
      );
    return result.stdout.trim();
  };
  const pin = checked(['ls-tree', 'HEAD', '--', path]).match(/^160000 commit ([a-f0-9]{40})\t/);
  if (!pin) throw new Error(`[wgpu-checkout] missing gitlink: ${path}`);
  const authorization = run(['config', '--get-urlmatch', 'http.extraheader', 'https://github.com']);
  if (authorization.status === 0 && authorization.stdout.trim()) {
    const index = Number(env.GIT_CONFIG_COUNT ?? 0);
    env.GIT_CONFIG_COUNT = String(index + 1);
    env[`GIT_CONFIG_KEY_${index}`] = 'http.https://github.com/.extraheader';
    env[`GIT_CONFIG_VALUE_${index}`] = authorization.stdout.trim();
  }
  checked(['submodule', 'sync', '--', path]);
  checked(['submodule', 'update', '--init', '--depth=1', '--', path]);
  const actual = checked(['-C', path, 'rev-parse', 'HEAD']);
  if (actual !== pin[1])
    throw new Error(`[wgpu-checkout] pin mismatch: expected ${pin[1]}, actual ${actual}`);
  return { path, commit: actual };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepareWgpuCheckout()));
}
