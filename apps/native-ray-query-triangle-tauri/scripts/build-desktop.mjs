#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { generateIcons } from './generate-icons.mjs';

const appRoot = new URL('../', import.meta.url);
generateIcons();

const bundle =
  process.platform === 'darwin' ? 'app' : process.platform === 'win32' ? 'nsis' : 'appimage';
const result = spawnSync('pnpm', ['exec', 'tauri', 'build', '--bundles', bundle], {
  cwd: appRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
