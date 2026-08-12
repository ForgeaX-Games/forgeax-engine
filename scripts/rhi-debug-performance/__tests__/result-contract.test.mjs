import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePerformanceResult } from '../../rhi-debug-performance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures');
const runnerPath = resolve(here, '..', '..', 'rhi-debug-performance.mjs');
const readFixture = (name) => JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'));

describe('RHI-debug performance result contract', () => {
  it('accepts one conforming sample', () => {
    const result = validatePerformanceResult(readFixture('valid-result.json'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects the retained malformed sample', () => {
    const result = validatePerformanceResult(readFixture('malformed-result.json'));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown top-level field', () => {
    const fixture = readFixture('valid-result.json');
    fixture.unownedField = true;
    const result = validatePerformanceResult(fixture);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('unownedField');
  });

  it('accepts the conventional pnpm separator before options', () => {
    const help = execFileSync(process.execPath, [runnerPath, '--', '--help'], {
      encoding: 'utf8',
    });
    expect(help).toContain('Run the admitted Lighting Maps Dawn capture path');
  });
});
