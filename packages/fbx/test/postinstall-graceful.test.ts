import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  'scripts',
  'postinstall.mjs',
);

function runPostinstall(envOverrides: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      FBX_SDK_ROOT: '', // explicitly clear
      PATH: process.env.PATH ?? '',
      ...envOverrides,
    },
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

describe('postinstall graceful-degrade', () => {
  it('exits 0 when FBX_SDK_ROOT is not set', () => {
    const result = runPostinstall({});
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('FBX_SDK_ROOT not set');
  });

  it('exits 0 when FBX_SDK_ROOT points to nonexistent directory', () => {
    const result = runPostinstall({ FBX_SDK_ROOT: '/nonexistent/path' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('FBX_SDK_ROOT not set');
  });

  it('exits 0 when include/ directory is missing', () => {
    // Use /tmp which exists but has no include/ subdir
    const result = runPostinstall({ FBX_SDK_ROOT: '/tmp' });
    // /tmp may or may not have include/ — if it does, node-gyp may fail.
    // The acceptance criterion is: postinstall never blocks install.
    expect(result.status).toBe(0);
  });

  it('does not output to stdout', () => {
    const result = runPostinstall({});
    expect(result.stdout).toBe('');
  });
});