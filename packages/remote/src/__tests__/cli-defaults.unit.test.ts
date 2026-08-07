import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ConnectFn,
  INSPECTOR_DEFAULT_HOST,
  INSPECTOR_DEFAULT_PORT,
} from '@forgeax/engine-types/inspector-client';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../cli';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts'),
  'utf8',
);

const client: ConnectFn = async () => ({
  ok: true,
  value: {
    eval: async () => null,
    dispose: async () => {},
  },
});

describe('remote inspector connection defaults', () => {
  it('uses the inspector-client owner instead of a local default ledger', () => {
    expect(source).toContain('INSPECTOR_DEFAULT_PORT');
    expect(source).toContain('INSPECTOR_DEFAULT_HOST');
    expect(source).not.toContain('const DEFAULT_PORT');
    expect(source).not.toContain('const DEFAULT_HOST');
  });

  it('builds the owned default target and preserves explicit overrides', async () => {
    let defaultUrl: string | undefined;
    const defaultExitCode = await dispatch({
      argv: ['node', 'forgeax', 'eval', 'world.inspect()'],
      stdoutWrite: () => {},
      stderrWrite: () => {},
      connect: async (url) => {
        defaultUrl = url;
        return client(url);
      },
    });
    expect(defaultExitCode).toBe(0);
    expect(defaultUrl).toBe(`ws://${INSPECTOR_DEFAULT_HOST}:${INSPECTOR_DEFAULT_PORT}/inspector`);

    let overriddenUrl: string | undefined;
    const overriddenExitCode = await dispatch({
      argv: [
        'node',
        'forgeax',
        'eval',
        '--port',
        '6000',
        '--host',
        'inspector.example',
        'world.inspect()',
      ],
      stdoutWrite: () => {},
      stderrWrite: () => {},
      connect: async (url) => {
        overriddenUrl = url;
        return client(url);
      },
    });
    expect(overriddenExitCode).toBe(0);
    expect(overriddenUrl).toBe('ws://inspector.example:6000/inspector');
  });
});
