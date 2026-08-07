import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSPECTOR_DEFAULT_HOST,
  INSPECTOR_DEFAULT_PORT,
} from '@forgeax/engine-types/inspector-client';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli-ecs.ts'),
  'utf8',
);

describe('ecs inspector connection defaults', () => {
  it('uses the inspector-client owner instead of a local default ledger', () => {
    expect(source).toContain('INSPECTOR_DEFAULT_PORT');
    expect(source).toContain('INSPECTOR_DEFAULT_HOST');
    expect(source).not.toContain('const DEFAULT_PORT');
    expect(source).not.toContain('const DEFAULT_HOST');
  });

  it('keeps owned defaults and explicit overrides in the parser', async () => {
    const { parseCliArgs } = await import('../cli-ecs');
    const defaults = parseCliArgs(['entities']);
    if (!defaults.ok) throw new Error(defaults.message);
    expect(defaults.value.port).toBe(INSPECTOR_DEFAULT_PORT);
    expect(defaults.value.host).toBe(INSPECTOR_DEFAULT_HOST);

    const overridden = parseCliArgs(['entities', '--port', '6000', '--host', 'inspector.example']);
    if (!overridden.ok) throw new Error(overridden.message);
    expect(overridden.value.port).toBe(6000);
    expect(overridden.value.host).toBe('inspector.example');
  });
});
