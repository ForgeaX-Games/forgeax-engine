#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export function generateIcons() {
  const appRoot = new URL('../', import.meta.url);
  const iconSource = resolve(mkdtempSync(resolve(tmpdir(), 'forgeax-tauri-icon-')), 'icon.svg');
  writeFileSync(
    iconSource,
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#10151d"/><path d="M108 360 256 88l148 272h-78l-70-132-70 132z" fill="#81d4fa"/></svg>',
  );
  const result = spawnSync('pnpm', ['exec', 'tauri', 'icon', iconSource], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`Tauri icon generation exited ${result.status}`);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) generateIcons();
